//! High-resolution manga layout instance segmentation with RF-DETR Seg 2XL.
//!
//! Checkpoint and strict Python loader:
//! https://huggingface.co/mayocream/koharu-layout-rfdetr-seg-2xl-1152/tree/aed55fdb8ca953c6bec33cf6ed6dd52a9b72bfa2
//! RF-DETR upstream implementation:
//! https://github.com/roboflow/rf-detr/tree/4ab7c18729de9d02ffd0495795d0831b5630f01b

mod config;
mod model;
mod processor;

use anyhow::{Context, Result, ensure};
use image::DynamicImage;
use koharu_torch::{Device, Tensor};

use crate::backend::TryIntoDevice;

use self::processor::{InferenceTile, map_detection_to_page, pad_tile, plan_tiles};
pub use self::{
    config::{KoharuLayoutRFDetrSeg2XLConfig, KoharuLayoutThresholds},
    processor::{
        KoharuLayoutDetection, KoharuLayoutDetections, KoharuLayoutMask,
        KoharuLayoutRFDetrImageProcessor,
    },
};

use self::model::{Model, Output};

/// CPU-prepared source page for grouped RF-DETR inference.
///
/// This is exposed so callers can prepare upcoming pages while the accelerator
/// processes the current batch. The stored tile pixels remain on the CPU.
pub struct PreparedKoharuLayoutImage {
    width: u32,
    height: u32,
    tile_size: u32,
    tiles: Vec<(InferenceTile, image::RgbImage)>,
}

crate::model_repository!("mayocream/koharu-layout-rfdetr-seg-2xl-1152" @ "aed55fdb8ca953c6bec33cf6ed6dd52a9b72bfa2" {
    CONFIG = "inference_config.json",
    WEIGHTS = "model.safetensors",
});

#[derive(Debug)]
pub struct KoharuLayoutRFDetrSeg2XL {
    device: Device,
    model: Model,
    processor: KoharuLayoutRFDetrImageProcessor,
}

impl KoharuLayoutRFDetrSeg2XL {
    pub async fn load(device: crate::Device) -> Result<Self> {
        let device: Device = device.try_into_device()?;
        let config_path = CONFIG
            .resolve()
            .await
            .context("failed to resolve KoharuLayout RF-DETR inference config")?;
        let weights_path = WEIGHTS
            .resolve()
            .await
            .context("failed to resolve KoharuLayout RF-DETR weights")?;
        let config = KoharuLayoutRFDetrSeg2XLConfig::from_file(&config_path)?;
        let processor = KoharuLayoutRFDetrImageProcessor::new(&config)?;
        let mut model = Model::new(device);
        model
            .load(&weights_path)
            .with_context(|| format!("failed to load {}", weights_path.display()))?;
        Ok(Self {
            device,
            model,
            processor,
        })
    }

    pub fn inference(&self, image: &DynamicImage) -> Result<KoharuLayoutDetections> {
        self.inference_with_thresholds(image, self.processor.recommended_thresholds())
    }

    pub fn inference_with_thresholds(
        &self,
        image: &DynamicImage,
        thresholds: KoharuLayoutThresholds,
    ) -> Result<KoharuLayoutDetections> {
        koharu_torch::no_grad(|| {
            let width = image.width();
            let height = image.height();
            ensure!(width > 0 && height > 0, "cannot segment an empty image");
            let resolution = self.processor.resolution();
            let source = image.to_rgb8();
            let mut detections = Vec::<KoharuLayoutDetection>::new();

            // The checkpoint requires square inputs. Analyze overlapping native-scale
            // tiles so tall pages do not lose small lettering when squeezed into one square.
            for tile in plan_tiles(width, height, resolution) {
                let tile_image = DynamicImage::ImageRgb8(pad_tile(&source, tile, resolution));
                let pixel_values = self.processor.preprocess(&tile_image, self.device)?;
                let output = self.model.forward(&pixel_values);
                let mut tile_result = self
                    .processor
                    .postprocess(&output, resolution, resolution, thresholds)?;
                detections.extend(
                    tile_result.detections.drain(..).filter_map(|detection| {
                        map_detection_to_page(detection, tile, width, height)
                    }),
                );
            }

            Ok(KoharuLayoutDetections {
                image_width: width,
                image_height: height,
                detections,
            })
        })
    }

    /// Decodes the page into RGB and creates its padded inference tiles on CPU.
    pub fn prepare(image: &DynamicImage, tile_size: u32) -> Result<PreparedKoharuLayoutImage> {
        let width = image.width();
        let height = image.height();
        ensure!(width > 0 && height > 0, "cannot segment an empty image");
        ensure!(tile_size > 0, "tile size must be positive");
        let source = image.to_rgb8();
        let tiles = plan_tiles(width, height, tile_size)
            .into_iter()
            .map(|tile| (tile, pad_tile(&source, tile, tile_size)))
            .collect();
        Ok(PreparedKoharuLayoutImage {
            width,
            height,
            tile_size,
            tiles,
        })
    }

    /// Runs one model forward pass for the next compatible tile from each page.
    ///
    /// Prepared pages may have different tile counts. Each iteration batches
    /// the tile at the same index from all pages that still have one.
    pub fn inference_prepared_batch_with_thresholds(
        &self,
        images: &[PreparedKoharuLayoutImage],
        thresholds: KoharuLayoutThresholds,
    ) -> Result<Vec<KoharuLayoutDetections>> {
        ensure!(!images.is_empty(), "cannot infer an empty page batch");
        koharu_torch::no_grad(|| {
            let resolution = self.processor.resolution();
            ensure!(
                images.iter().all(|image| image.tile_size == resolution),
                "prepared pages use a different tile size than the loaded detector"
            );
            let max_tiles = images
                .iter()
                .map(|image| image.tiles.len())
                .max()
                .unwrap_or(0);
            let mut page_detections = (0..images.len())
                .map(|_| Vec::new())
                .collect::<Vec<Vec<KoharuLayoutDetection>>>();

            for tile_index in 0..max_tiles {
                let mut pixel_values = Vec::with_capacity(images.len());
                let mut owners = Vec::with_capacity(images.len());
                for (page_index, image) in images.iter().enumerate() {
                    if let Some((tile, tile_image)) = image.tiles.get(tile_index) {
                        let tile_image = DynamicImage::ImageRgb8(tile_image.clone());
                        pixel_values.push(self.processor.preprocess(&tile_image, self.device)?);
                        owners.push((page_index, *tile));
                    }
                }
                if pixel_values.is_empty() {
                    continue;
                }

                let batch = Tensor::cat(&pixel_values, 0);
                let output = self.model.forward(&batch);
                for (batch_index, (page_index, tile)) in owners.into_iter().enumerate() {
                    let batch_index = batch_index as i64;
                    let item = Output {
                        pred_logits: output.pred_logits.narrow(0, batch_index, 1),
                        pred_boxes: output.pred_boxes.narrow(0, batch_index, 1),
                        pred_masks: output.pred_masks.narrow(0, batch_index, 1),
                    };
                    let tile_output = self
                        .processor
                        .postprocess(&item, resolution, resolution, thresholds)?;
                    let page = &images[page_index];
                    page_detections[page_index].extend(
                        tile_output.detections.into_iter().filter_map(|detection| {
                            map_detection_to_page(detection, tile, page.width, page.height)
                        }),
                    );
                }
            }

            Ok(images
                .iter()
                .zip(page_detections)
                .map(|(image, detections)| KoharuLayoutDetections {
                    image_width: image.width,
                    image_height: image.height,
                    detections,
                })
                .collect())
        })
    }

    /// Convenience path that prepares pages and then runs grouped inference.
    pub fn inference_batch_with_thresholds(
        &self,
        images: &[DynamicImage],
        thresholds: KoharuLayoutThresholds,
    ) -> Result<Vec<KoharuLayoutDetections>> {
        let prepared = images
            .iter()
            .map(|image| Self::prepare(image, self.processor.resolution()))
            .collect::<Result<Vec<_>>>()?;
        self.inference_prepared_batch_with_thresholds(&prepared, thresholds)
    }

    pub fn recommended_thresholds(&self) -> KoharuLayoutThresholds {
        self.processor.recommended_thresholds()
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use anyhow::Result;

    use super::KoharuLayoutRFDetrSeg2XL;

    #[tokio::test]
    #[ignore = "downloads the checkpoint and requires CUDA"]
    async fn checkpoint_matches_rfdetr_upstream_structured_output() -> Result<()> {
        crate::init().await?;
        let image = image::open(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("benches/fixtures/object_detection/1.jpg"),
        )?;
        let model = KoharuLayoutRFDetrSeg2XL::load(crate::Device::cuda(0)).await?;
        let result = model.inference(&image)?;

        // RF-DETR 4ab7c18, CUDA BF16, shape=(1152, 1152), antialias disabled.
        // CUDA kernels vary across LibTorch releases, so compare structured
        // geometry and mask area in addition to bounded confidence differences.
        let best = &result.detections[0];
        assert_eq!(best.label, "bubble");
        assert!((best.score - 0.968_856_2).abs() < 0.01);
        for (actual, expected) in best
            .bbox
            .into_iter()
            .zip([566.220_7, 550.019_5, 691.044_9, 724.043])
        {
            assert!((actual - expected).abs() < 6.0);
        }
        assert!(best.area.abs_diff(18_882) < 100);

        let lower_panel = result
            .detections
            .iter()
            .find(|detection| detection.label == "panel" && detection.bbox[1] > 700.0)
            .expect("lower page panel");
        let middle_panel = result
            .detections
            .iter()
            .find(|detection| {
                detection.label == "panel" && detection.bbox[1] > 500.0 && detection.bbox[1] < 700.0
            })
            .expect("middle page panel");
        for (actual, expected) in lower_panel
            .bbox
            .into_iter()
            .zip([69.179_69, 799.453_1, 700.820_3, 1006.171_9])
        {
            assert!((actual - expected).abs() < 7.0);
        }
        for (actual, expected) in middle_panel
            .bbox
            .into_iter()
            .zip([70.683_59, 550.546_9, 699.316_4, 782.578_1])
        {
            assert!((actual - expected).abs() < 3.0);
        }
        assert!(lower_panel.area.abs_diff(136_734) < 1_000);
        assert!(middle_panel.area.abs_diff(142_179) < 2_000);
        Ok(())
    }
}
