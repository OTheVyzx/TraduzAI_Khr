use std::sync::{Arc, Mutex};

use super::{StageInput, StageProcessor, finish, generation};
use crate::{ModelCell, OcrModel, scope::geometry_extents};
use anyhow::{Context as _, Result, anyhow, bail};
use async_trait::async_trait;
use image::{DynamicImage, GenericImageView as _, GrayImage, Luma, Rgba, RgbaImage};
use imageproc::drawing::draw_polygon_mut;
use imageproc::geometric_transformations::{Border, Interpolation, Projection, warp_into};
use imageproc::point::Point as ImagePoint;
use koharu_ml::{
    baberu_ocr::BaberuOcr, hayai_ocr::HayaiOcr, manga_ocr::MangaOcr,
    paddle_ocr_vl::PaddleOCRVLTask, paddle_ocr_vl_quantized::PaddleOCRVLQuantized,
};
use koharu_scene::{
    Authored, EntityId, Geometry, LanguageTag, OcrAnalysis, Origin, RecognizedFrom, Region,
    RegionSpec, SourceText, TextDirection, TextRegion,
};

const PRODUCER: &str = "dev.koharu.pipeline.ocr";

pub(super) struct Processor {
    config: OcrModel,
    device: koharu_ml::Device,
    model: ModelCell<Model>,
}

impl Processor {
    pub(super) fn new(config: OcrModel, device: koharu_ml::Device) -> Self {
        Self {
            config,
            device,
            model: ModelCell::new(),
        }
    }
}

#[async_trait]
impl StageProcessor for Processor {
    fn model(&self) -> &'static str {
        match self.config {
            OcrModel::MangaOcr => "manga-ocr",
            OcrModel::BaberuOcr => "baberu-ocr",
            OcrModel::HayaiOcr => "hayai-ocr",
            OcrModel::PaddleOcrVl1_6 => "paddleocr-vl-1.6",
        }
    }

    fn unload(&self) -> bool {
        self.model.unload()
    }

    async fn load(&self) -> Result<()> {
        self.model
            .ensure(|| Model::load(self.device.clone(), &self.config))
            .await
    }

    async fn process(&self, input: StageInput) -> Result<koharu_scene::Patch> {
        self.model
            .lock()
            .await
            .as_ref()
            .ok_or_else(|| anyhow!("OCR model is not loaded"))?
            .run(input)
            .await
    }
}

enum Model {
    Manga(Arc<Mutex<MangaOcr>>),
    Baberu(Arc<Mutex<BaberuOcr>>),
    Hayai(Arc<Mutex<HayaiOcr>>),
    Paddle(Arc<Mutex<PaddleOCRVLQuantized>>),
}

impl Model {
    async fn load(device: koharu_ml::Device, config: &OcrModel) -> Result<Self> {
        match config {
            OcrModel::MangaOcr => Ok(Self::Manga(Arc::new(Mutex::new(
                MangaOcr::load(device).await?,
            )))),
            OcrModel::BaberuOcr => Ok(Self::Baberu(Arc::new(Mutex::new(
                BaberuOcr::load(device).await?,
            )))),
            OcrModel::HayaiOcr => Ok(Self::Hayai(Arc::new(Mutex::new(
                HayaiOcr::load(device).await?,
            )))),
            OcrModel::PaddleOcrVl1_6 => Ok(Self::Paddle(Arc::new(Mutex::new(
                PaddleOCRVLQuantized::load(device).await?,
            )))),
        }
    }

    async fn run(&self, input: StageInput) -> Result<koharu_scene::Patch> {
        let model_name = match self {
            Self::Manga(_) => "manga-ocr",
            Self::Baberu(_) => "baberu-ocr",
            Self::Hayai(_) => "hayai-ocr",
            Self::Paddle(_) => "paddleocr-vl-1.6",
        };
        let page = input.page;
        let mut targets = Vec::new();
        let source = input
            .images
            .get(&input.scene, page, "source")
            .await?
            .ok_or_else(|| anyhow!("page {page} has no source image"))?;
        for entity in input.scene.descendants(page)? {
            let region = entity.id();
            if !input.contains_entity(region)? {
                continue;
            }
            let Some(region_data) = input.scene.component::<Region>(region)? else {
                continue;
            };
            if region_data.kind != TextRegion::kind() {
                continue;
            }
            let geometry = input
                .scene
                .component::<Geometry>(region)?
                .ok_or_else(|| anyhow!("text region {region} has no geometry"))?;
            let crop = crop(
                &source,
                &geometry,
                matches!(region_data.origin, Origin::User),
            )
            .with_context(|| format!("text region {region} is outside its source image"))?;
            for relation in input.scene.relations_to_as::<RecognizedFrom>(region) {
                let content = relation.value().source;
                let previous = input.scene.component::<SourceText>(content)?;
                if previous
                    .as_ref()
                    .is_some_and(|value| matches!(value.text.origin, Origin::User))
                {
                    continue;
                }
                targets.push(OcrTarget {
                    content,
                    region,
                    geometry: geometry.clone(),
                    previous,
                    image: crop.clone(),
                });
            }
        }

        let results = match self {
            Self::Manga(model) => {
                infer_text(model.clone(), targets, |model, image| {
                    model.inference(image)
                })
                .await?
            }
            Self::Baberu(model) => {
                infer_text(model.clone(), targets, |model, image| {
                    model.inference(image)
                })
                .await?
            }
            Self::Hayai(model) => {
                infer_text(model.clone(), targets, |model, image| {
                    model.inference(image)
                })
                .await?
            }
            Self::Paddle(model) => {
                infer_text(model.clone(), targets, |model, image| {
                    Ok(model.inference(image, PaddleOCRVLTask::Ocr)?.text)
                })
                .await?
            }
        };

        let generation = generation(PRODUCER, model_name)?;
        let mut edit = input.scene.edit_as(generation.clone());
        edit.observe_assets(page)?;
        for result in &results {
            edit.observe::<Region>(result.region)?;
            edit.observe::<Geometry>(result.region)?;
            edit.observe::<SourceText>(result.content)?;
        }
        for result in results {
            let language = result
                .previous
                .and_then(|value| value.language)
                .or_else(|| LanguageTag::new("ja-JP").ok());
            edit.set(
                result.content,
                &SourceText {
                    text: Authored::generated(result.text, generation.clone()),
                    language,
                },
            )?;
            edit.set(
                result.region,
                &OcrAnalysis {
                    origin: Origin::Generated(generation.clone()),
                    direction: text_direction(&result.geometry)?,
                    confidence: None,
                    line_boundaries: Vec::new(),
                },
            )?;
        }
        finish(edit)
    }
}

struct OcrTarget {
    content: EntityId,
    region: EntityId,
    geometry: Geometry,
    previous: Option<SourceText>,
    image: DynamicImage,
}

struct OcrResult {
    content: EntityId,
    region: EntityId,
    geometry: Geometry,
    previous: Option<SourceText>,
    text: String,
}

async fn infer_text<M: Send + 'static>(
    model: Arc<Mutex<M>>,
    targets: Vec<OcrTarget>,
    inference: impl Fn(&M, &DynamicImage) -> Result<String> + Send + Sync + 'static,
) -> Result<Vec<OcrResult>> {
    tokio_rayon::spawn(move || {
        let model = model
            .lock()
            .map_err(|_| anyhow!("OCR model lock is poisoned"))?;
        targets
            .into_iter()
            .map(|target| {
                Ok(OcrResult {
                    content: target.content,
                    region: target.region,
                    geometry: target.geometry,
                    previous: target.previous,
                    text: normalize_ocr_text(inference(&model, &target.image)?),
                })
            })
            .collect()
    })
    .await
}

// Manga OCR can emit replacement-box glyphs for an isolated Japanese ellipsis.
// Normalize only an all-placeholder sequence so ordinary OCR output is preserved.
fn normalize_ocr_text(text: String) -> String {
    let visible = text
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect::<Vec<_>>();
    if visible.len() >= 2
        && visible
            .iter()
            .all(|character| matches!(character, '☐' | '□' | '▢' | '▣' | '�'))
    {
        "…".to_owned()
    } else {
        text
    }
}

fn text_direction(geometry: &Geometry) -> Result<TextDirection> {
    let (width, height) = if geometry.points.len() == 4 && convex_quad(&geometry.points) {
        let points = &geometry.points;
        let edge =
            |a: usize, b: usize| (points[a].x - points[b].x).hypot(points[a].y - points[b].y);
        (edge(0, 1).max(edge(2, 3)), edge(1, 2).max(edge(3, 0)))
    } else {
        let (min_x, min_y, max_x, max_y) =
            geometry_extents(geometry).ok_or_else(|| anyhow!("geometry is empty"))?;
        (max_x - min_x, max_y - min_y)
    };
    Ok(if height >= width * 1.15 {
        TextDirection::Vertical
    } else {
        TextDirection::Horizontal
    })
}

fn crop(source: &DynamicImage, geometry: &Geometry, isolate_polygon: bool) -> Result<DynamicImage> {
    let (min_x, min_y, max_x, max_y) =
        geometry_extents(geometry).ok_or_else(|| anyhow!("geometry is empty"))?;
    let isolated = isolate_polygon.then(|| isolate_polygon_pixels(source, geometry));
    let source = isolated.as_ref().unwrap_or(source);
    if geometry.points.len() == 4 && convex_quad(&geometry.points) {
        let points = &geometry.points;
        let edge =
            |a: usize, b: usize| (points[a].x - points[b].x).hypot(points[a].y - points[b].y);
        let width = edge(0, 1).max(edge(2, 3));
        let height = edge(1, 2).max(edge(3, 0));
        if width.is_finite() && height.is_finite() && width >= 1.0 && height >= 1.0 {
            let margin = (width.min(height) * 0.08).clamp(2.0, 12.0);
            let output_width = (width + margin * 2.0).ceil() as u32;
            let output_height = (height + margin * 2.0).ceil() as u32;
            // Malformed model geometry must never allocate an unbounded OCR image.
            if output_width <= source.width().saturating_mul(2)
                && output_height <= source.height().saturating_mul(2)
            {
                let from =
                    std::array::from_fn(|index| (points[index].x as f32, points[index].y as f32));
                let margin = margin as f32;
                let to = [
                    (margin, margin),
                    (margin + width as f32, margin),
                    (margin + width as f32, margin + height as f32),
                    (margin, margin + height as f32),
                ];
                if let Some(projection) = Projection::from_control_points(from, to) {
                    let mut output = RgbaImage::from_pixel(
                        output_width,
                        output_height,
                        Rgba([255, 255, 255, 255]),
                    );
                    warp_into(
                        &source.to_rgba8(),
                        projection,
                        Interpolation::Bilinear,
                        Border::Constant(Rgba([255, 255, 255, 255])),
                        &mut output,
                    );
                    return Ok(DynamicImage::ImageRgba8(output));
                }
            }
        }
    }
    let margin = ((max_x - min_x).min(max_y - min_y) * 0.08).clamp(2.0, 12.0);
    let x = (min_x - margin).floor().max(0.0) as u32;
    let y = (min_y - margin).floor().max(0.0) as u32;
    let right = (max_x + margin)
        .ceil()
        .max(0.0)
        .min(f64::from(source.width())) as u32;
    let bottom = (max_y + margin)
        .ceil()
        .max(0.0)
        .min(f64::from(source.height())) as u32;
    if right <= x || bottom <= y {
        bail!("geometry does not overlap the image");
    }
    Ok(source.crop_imm(x, y, right - x, bottom - y))
}

fn convex_quad(points: &[koharu_scene::Point]) -> bool {
    let mut sign = 0.0_f64;
    for index in 0..4 {
        let a = points[index];
        let b = points[(index + 1) % 4];
        let c = points[(index + 2) % 4];
        let cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
        if cross.abs() < 1e-9 || (sign != 0.0 && sign.signum() != cross.signum()) {
            return false;
        }
        sign = cross;
    }
    true
}

fn isolate_polygon_pixels(source: &DynamicImage, geometry: &Geometry) -> DynamicImage {
    let (width, height) = source.dimensions();
    let mut mask = GrayImage::new(width, height);
    let points = geometry
        .points
        .iter()
        .map(|point| ImagePoint::new(point.x.round() as i32, point.y.round() as i32))
        .collect::<Vec<_>>();
    draw_polygon_mut(&mut mask, &points, Luma([255]));
    let mut isolated = RgbaImage::from_pixel(width, height, Rgba([255, 255, 255, 255]));
    if let Some((min_x, min_y, max_x, max_y)) = geometry_extents(geometry) {
        let first_x = min_x.floor().max(0.0) as u32;
        let first_y = min_y.floor().max(0.0) as u32;
        let last_x = max_x.ceil().min(f64::from(width)) as u32;
        let last_y = max_y.ceil().min(f64::from(height)) as u32;
        for y in first_y..last_y {
            for x in first_x..last_x {
                if mask.get_pixel(x, y).0[0] != 0 {
                    isolated.put_pixel(x, y, source.get_pixel(x, y));
                }
            }
        }
    }
    DynamicImage::ImageRgba8(isolated)
}

#[cfg(test)]
mod tests {
    use super::{crop, normalize_ocr_text, text_direction};
    use image::{DynamicImage, Rgba, RgbaImage};
    use koharu_scene::{Geometry, Origin, Point, TextDirection};

    #[test]
    fn crop_straightens_a_rotated_text_region_and_keeps_a_margin() {
        let source = DynamicImage::ImageRgba8(RgbaImage::from_pixel(40, 40, Rgba([255; 4])));
        let geometry = Geometry {
            origin: Origin::User,
            points: vec![
                Point { x: 12.0, y: 8.0 },
                Point { x: 24.0, y: 20.0 },
                Point { x: 20.0, y: 24.0 },
                Point { x: 8.0, y: 12.0 },
            ],
        };

        let result = crop(&source, &geometry, false).unwrap();
        assert!(result.width() > result.height());
        assert!(result.width() >= 20);
        assert!(result.height() >= 9);
        assert_eq!(
            text_direction(&geometry).unwrap(),
            TextDirection::Horizontal
        );
    }

    #[test]
    fn manual_polygon_ocr_excludes_pixels_outside_the_selection() {
        let source = DynamicImage::ImageRgba8(RgbaImage::from_pixel(12, 12, Rgba([0, 0, 0, 255])));
        let geometry = Geometry {
            origin: Origin::User,
            points: vec![
                Point { x: 2.0, y: 2.0 },
                Point { x: 10.0, y: 2.0 },
                Point { x: 2.0, y: 10.0 },
            ],
        };
        let selected = crop(&source, &geometry, true).unwrap().to_rgba8();
        assert_eq!(selected.get_pixel(3, 3).0, [0, 0, 0, 255]);
        assert_eq!(selected.get_pixel(8, 8).0, [255, 255, 255, 255]);

        let concave = Geometry {
            origin: Origin::User,
            points: vec![
                Point { x: 0.0, y: 0.0 },
                Point { x: 12.0, y: 0.0 },
                Point { x: 12.0, y: 12.0 },
                Point { x: 7.0, y: 12.0 },
                Point { x: 7.0, y: 5.0 },
                Point { x: 5.0, y: 5.0 },
                Point { x: 5.0, y: 12.0 },
                Point { x: 0.0, y: 12.0 },
            ],
        };
        let selected = crop(&source, &concave, true).unwrap().to_rgba8();
        assert_eq!(selected.get_pixel(3, 9).0, [0, 0, 0, 255]);
        assert_eq!(selected.get_pixel(6, 9).0, [255, 255, 255, 255]);
    }

    #[test]
    fn repeated_placeholder_glyphs_are_an_ellipsis() {
        assert_eq!(normalize_ocr_text("☐ ☐ ☐".to_owned()), "…");
        assert_eq!(normalize_ocr_text("□\n□".to_owned()), "…");
    }

    #[test]
    fn ordinary_text_and_single_boxes_are_unchanged() {
        assert_eq!(normalize_ocr_text("待って…".to_owned()), "待って…");
        assert_eq!(normalize_ocr_text("☐".to_owned()), "☐");
    }
}
