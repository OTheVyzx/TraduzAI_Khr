//! Manual CUDA timing probe for grouped RF-DETR inference and CPU preparation.
//! This is test-only and does not change production pipeline scheduling.

use anyhow::{Context as _, Result, anyhow, ensure};
use koharu_ml::{
    Backend,
    koharu_layout_rfdetr_seg_2xl::{KoharuLayoutRFDetrSeg2XL, PreparedKoharuLayoutImage},
};
use rayon::prelude::*;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
    time::Instant,
};

struct Page {
    name: String,
    bytes: Arc<[u8]>,
}

const INPUT_RESOLUTION: u32 = 1152;

async fn prepare_batch(
    pages: Arc<Vec<Page>>,
    pool: Arc<rayon::ThreadPool>,
    range: std::ops::Range<usize>,
) -> Result<(Vec<PreparedKoharuLayoutImage>, f64)> {
    let started = Instant::now();
    let prepared = tokio::task::spawn_blocking(move || {
        pool.install(|| {
            range
                .into_par_iter()
                .map(|index| -> Result<_> {
                    let page = &pages[index];
                    let image = image::load_from_memory(&page.bytes)
                        .with_context(|| format!("failed to decode {}", page.name))?;
                    KoharuLayoutRFDetrSeg2XL::prepare(&image, INPUT_RESOLUTION)
                })
                .collect::<Result<Vec<_>>>()
        })
    })
    .await??;
    Ok((prepared, started.elapsed().as_secs_f64()))
}

async fn infer_batch(
    model: Arc<super::Model>,
    prepared: Vec<PreparedKoharuLayoutImage>,
) -> Result<f64> {
    let network = model.network.clone();
    let thresholds = model.thresholds;
    Ok(tokio_rayon::spawn(move || -> Result<f64> {
        let network = network
            .lock()
            .map_err(|_| anyhow!("layout model lock is poisoned"))?;
        let started = Instant::now();
        let outputs = network.inference_prepared_batch_with_thresholds(&prepared, thresholds)?;
        koharu_ml::torch::Cuda::synchronize(0);
        drop(outputs);
        Ok(started.elapsed().as_secs_f64())
    })
    .await?)
}

fn page_ranges(page_count: usize, batch_size: usize) -> Vec<std::ops::Range<usize>> {
    (0..page_count)
        .step_by(batch_size)
        .map(|start| start..(start + batch_size).min(page_count))
        .collect()
}

async fn run_serial_prepare(
    model: Arc<super::Model>,
    pages: Arc<Vec<Page>>,
    pool: Arc<rayon::ThreadPool>,
    batch_size: usize,
) -> Result<(f64, f64, f64)> {
    let wall_started = Instant::now();
    let mut prepare_sum = 0.0;
    let mut infer_sum = 0.0;
    for range in page_ranges(pages.len(), batch_size) {
        let (prepared, prepare_s) = prepare_batch(pages.clone(), pool.clone(), range).await?;
        prepare_sum += prepare_s;
        infer_sum += infer_batch(model.clone(), prepared).await?;
    }
    Ok((wall_started.elapsed().as_secs_f64(), prepare_sum, infer_sum))
}

async fn run_overlapped_prepare(
    model: Arc<super::Model>,
    pages: Arc<Vec<Page>>,
    pool: Arc<rayon::ThreadPool>,
    batch_size: usize,
) -> Result<(f64, f64, f64)> {
    let ranges = page_ranges(pages.len(), batch_size);
    let wall_started = Instant::now();
    let Some(first) = ranges.first().cloned() else {
        return Ok((0.0, 0.0, 0.0));
    };
    let (mut current, first_prepare_s) = prepare_batch(pages.clone(), pool.clone(), first).await?;
    let mut prepare_sum = first_prepare_s;
    let mut infer_sum = 0.0;

    for next_range in ranges.into_iter().skip(1) {
        let prepare_next = prepare_batch(pages.clone(), pool.clone(), next_range);
        let infer_current = infer_batch(model.clone(), current);
        let (prepared, inference_s) = tokio::join!(prepare_next, infer_current);
        let (next, prepare_s) = prepared?;
        current = next;
        prepare_sum += prepare_s;
        infer_sum += inference_s?;
    }
    infer_sum += infer_batch(model, current).await?;
    Ok((wall_started.elapsed().as_secs_f64(), prepare_sum, infer_sum))
}

async fn warm_batch(
    model: Arc<super::Model>,
    pages: Arc<Vec<Page>>,
    pool: Arc<rayon::ThreadPool>,
    batch_size: usize,
) -> Result<f64> {
    let range = 0..batch_size.min(pages.len());
    let (prepared, prepare_s) = prepare_batch(pages, pool, range).await?;
    let inference_s = infer_batch(model, prepared).await?;
    Ok(prepare_s + inference_s)
}

fn load_pages(input: &Path) -> Result<Vec<Page>> {
    let mut paths = fs::read_dir(input)?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<std::io::Result<Vec<_>>>()?;
    paths.retain(|path| {
        path.extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("webp"))
    });
    paths.sort();
    paths
        .into_iter()
        .map(|path| {
            Ok(Page {
                name: path
                    .file_name()
                    .context("input page has no filename")?
                    .to_string_lossy()
                    .into_owned(),
                bytes: Arc::from(fs::read(&path)?),
            })
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
#[ignore = "manual CUDA benchmark; requires DETECT_BATCH_PROBE_INPUT and DETECT_BATCH_PROBE_OUTPUT"]
async fn chapter_detection_batch_and_prepare() -> Result<()> {
    let input = PathBuf::from(std::env::var("DETECT_BATCH_PROBE_INPUT")?);
    let output = PathBuf::from(std::env::var("DETECT_BATCH_PROBE_OUTPUT")?);
    let sizes = std::env::var("DETECT_BATCH_SIZES").unwrap_or_else(|_| "1,2,3,4".into());
    fs::create_dir_all(&output)?;
    let pages = Arc::new(load_pages(&input)?);
    ensure!(!pages.is_empty(), "no WebP pages in {}", input.display());

    let load_started = Instant::now();
    koharu_ml::init().await?;
    let device = koharu_ml::device(false);
    ensure!(device.backend == Backend::Cuda, "CUDA required: {device:?}");
    let model = Arc::new(
        super::Model::load(
            device.clone(),
            &crate::PipelineConfig::default().detection()?,
        )
        .await?,
    );
    let load_s = load_started.elapsed().as_secs_f64();
    let network = model.network.clone();
    let thresholds = model.thresholds;
    let warm_network = network.clone();
    let warm_pages = pages.clone();
    let warm_s = tokio_rayon::spawn(move || -> Result<f64> {
        let guard = warm_network
            .lock()
            .map_err(|_| anyhow!("layout model lock is poisoned"))?;
        let started = Instant::now();
        let image = image::load_from_memory(&warm_pages[0].bytes)?;
        let prepared = guard.inference_batch_with_thresholds(&[image], thresholds)?;
        koharu_ml::torch::Cuda::synchronize(0);
        drop(prepared);
        Ok(started.elapsed().as_secs_f64())
    })
    .await?;
    let pool = Arc::new(
        rayon::ThreadPoolBuilder::new()
            .num_threads(4)
            .thread_name(|index| format!("detect-prep-{index}"))
            .build()?,
    );
    let mut summary = fs::File::create(output.join("summary.tsv"))?;
    writeln!(
        summary,
        "batch_size\tmode\tpages\tprep_workers\twall_s\tprepare_sum_s\tinference_sum_s"
    )?;
    summary.flush()?;
    fs::write(
        output.join("setup.txt"),
        format!(
            "input={}\npages={}\ndevice={device:?}\nmodel_load_s={load_s:.6}\nwarmup_s={warm_s:.6}\nprofile=debug\nprep_workers=4\nmode=serial_prepare means each page batch is fully decoded and tile-prepared before GPU inference; overlapped_prepare prepares the next page batch on CPU while the current page batch is inferred on GPU\nquality_comparison=not_run\n",
            input.display(),
            pages.len(),
        ),
    )?;
    eprintln!(
        "READY device={device:?} pages={} load={load_s:.2}s warm={warm_s:.2}s prep_workers=4 sizes={sizes}",
        pages.len()
    );

    for size_text in sizes.split(',') {
        let batch_size = size_text.trim().parse::<usize>()?;
        ensure!((1..=4).contains(&batch_size), "batch size must be 1..=4");
        eprintln!("WARM batch_size={batch_size}");
        let warm_s = warm_batch(model.clone(), pages.clone(), pool.clone(), batch_size).await?;
        eprintln!("WARMED batch_size={batch_size} warm={warm_s:.2}s");

        for (mode, result) in [
            (
                "serial_prepare",
                run_serial_prepare(model.clone(), pages.clone(), pool.clone(), batch_size).await?,
            ),
            (
                "overlapped_prepare",
                run_overlapped_prepare(model.clone(), pages.clone(), pool.clone(), batch_size)
                    .await?,
            ),
        ] {
            let (wall_s, prepare_sum_s, inference_sum_s) = result;
            writeln!(
                summary,
                "{batch_size}\t{mode}\t{}\t4\t{wall_s:.6}\t{prepare_sum_s:.6}\t{inference_sum_s:.6}",
                pages.len()
            )?;
            summary.flush()?;
            eprintln!(
                "RESULT batch_size={batch_size} mode={mode} wall={wall_s:.3}s prepare_sum={prepare_sum_s:.3}s inference_sum={inference_sum_s:.3}s"
            );
        }
    }
    Ok(())
}
