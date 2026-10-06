//! Opt-in, detection-only chapter experiment. Production scheduling is unchanged.
use super::*;
use anyhow::ensure;
use futures::{StreamExt, stream};
use koharu_scene::{PageDraft, Session};
use std::{
    fs,
    hash::{Hash, Hasher},
    io::Write,
    path::PathBuf,
    time::Instant,
};

struct Page {
    name: String,
    bytes: Arc<[u8]>,
    width: u32,
    height: u32,
}

#[derive(Clone, Copy)]
struct Mode {
    name: &'static str,
    workers: usize,
    fixed: bool,
    whole_stage_lock: bool,
}

struct Completed {
    index: usize,
    patch: koharu_scene::Patch,
    digest: u64,
    regions: usize,
    decode: f64,
    inference_wait: f64,
    inference: f64,
    finish: f64,
}

fn fingerprint(output: &KoharuLayoutDetections) -> u64 {
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    output.image_width.hash(&mut hash);
    output.image_height.hash(&mut hash);
    for region in &output.detections {
        region.label.hash(&mut hash);
        region.score.to_bits().hash(&mut hash);
        region.bbox.map(f32::to_bits).hash(&mut hash);
        region.area.hash(&mut hash);
        (
            region.mask.x,
            region.mask.y,
            region.mask.width,
            region.mask.height,
        )
            .hash(&mut hash);
        region.mask.pixels.hash(&mut hash);
    }
    hash.finish()
}

// Same decode, network inference and patch construction as Model::run, with
// optional whole-stage exclusion and timings at the existing boundaries.
async fn process(
    model: Arc<Model>,
    input: StageInput,
    index: usize,
    gate: Option<Arc<tokio::sync::Mutex<()>>>,
) -> Result<Completed> {
    let _guard = match gate {
        Some(gate) => Some(gate.lock_owned().await),
        None => None,
    };
    let started = Instant::now();
    let image = input
        .images
        .get(&input.scene, input.page, "source")
        .await?
        .context("missing source")?;
    let decode = started.elapsed().as_secs_f64();
    let network = model.network.clone();
    let thresholds = model.thresholds;
    let source = image.clone();
    let queued = Instant::now();
    let (output, inference_wait, inference) = tokio_rayon::spawn(move || -> Result<_> {
        let network = network
            .lock()
            .map_err(|_| anyhow!("network lock poisoned"))?;
        let inference_wait = queued.elapsed().as_secs_f64();
        let started = Instant::now();
        let output = network.inference_with_thresholds(&source, thresholds)?;
        koharu_ml::torch::Cuda::synchronize(0);
        Ok((output, inference_wait, started.elapsed().as_secs_f64()))
    })
    .await?;
    // Comparing masks/boxes/scores is intentionally outside inference timing.
    let digest = fingerprint(&output);
    let regions = output.detections.len();
    let started = Instant::now();
    let patch = build_patch(&input, &image, output, &generation(PRODUCER, MODEL_ID)?).await?;
    Ok(Completed {
        index,
        patch,
        digest,
        regions,
        decode,
        inference_wait,
        inference,
        finish: started.elapsed().as_secs_f64(),
    })
}

async fn import(pages: &[Page]) -> Result<(Session, Vec<EntityId>)> {
    let mut session = Session::memory().await?;
    let mut edit = session.snapshot().edit();
    let mut ids = Vec::new();
    for page in pages {
        let id = edit.add_page(
            PageDraft::new(&page.name, page.width as f64, page.height as f64),
            At::End,
        )?;
        edit.set_asset(
            id,
            &AssetRole::new("source")?,
            AssetInput::new(
                page.bytes.clone(),
                "image/webp",
                AssetMetadata {
                    width: Some(page.width),
                    height: Some(page.height),
                    attributes: BTreeMap::new(),
                },
            ),
        )?;
        ids.push(id);
    }
    session.commit(edit.finish()?).await?;
    Ok((session, ids))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
#[ignore = "manual CUDA chapter benchmark; requires DETECT_PROBE_INPUT and DETECT_PROBE_OUTPUT"]
async fn chapter_detection_concurrency() -> Result<()> {
    let input = PathBuf::from(std::env::var("DETECT_PROBE_INPUT")?);
    let output = PathBuf::from(std::env::var("DETECT_PROBE_OUTPUT")?);
    fs::create_dir_all(&output)?;
    let mut log = fs::File::create(output.join("progress.tsv"))?;
    writeln!(
        log,
        "mode\tpage\tdecode_s\tinference_wait_s\tinference_s\tfinish_s\tcommit_s\tregions\tdigest\telapsed_s"
    )?;
    log.flush()?;
    let mut paths = fs::read_dir(&input)?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<std::io::Result<Vec<_>>>()?;
    paths.retain(|path| {
        path.extension()
            .is_some_and(|extension| extension == "webp")
    });
    paths.sort();
    let pages = paths
        .iter()
        .map(|path| -> Result<_> {
            let (width, height) = image::image_dimensions(path)?;
            Ok(Page {
                name: path.file_name().unwrap().to_string_lossy().into_owned(),
                bytes: Arc::from(fs::read(path)?),
                width,
                height,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    ensure!(!pages.is_empty(), "no WebP pages");
    let mut manifest = fs::File::create(output.join("inputs.tsv"))?;
    for page in &pages {
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        page.bytes.hash(&mut hash);
        writeln!(
            manifest,
            "{}\t{}\t{}\t{}\t{:016x}",
            page.name,
            page.width,
            page.height,
            page.bytes.len(),
            hash.finish()
        )?;
    }
    let load_started = Instant::now();
    koharu_ml::init().await?;
    let device = koharu_ml::device(false);
    ensure!(
        device.backend == koharu_ml::Backend::Cuda,
        "CUDA required: {device:?}"
    );
    let model = Arc::new(
        Model::load(
            device.clone(),
            &crate::PipelineConfig::default().detection()?,
        )
        .await?,
    );
    let load_s = load_started.elapsed().as_secs_f64();
    let (warm_session, warm_ids) = import(&pages[..1]).await?;
    let warm_started = Instant::now();
    process(
        model.clone(),
        StageInput::new(
            warm_session.snapshot(),
            warm_ids[0],
            None,
            None,
            Arc::new(crate::ImageCache::default()),
            None,
        ),
        0,
        None,
    )
    .await?;
    let warm_s = warm_started.elapsed().as_secs_f64();
    drop(warm_session);
    eprintln!(
        "READY device={device:?} pages={} load={load_s:.3}s warm={warm_s:.3}s",
        pages.len()
    );
    fs::write(
        output.join("setup.txt"),
        format!(
            "device={device:?}\npages={}\nload_s={load_s}\nwarm_s={warm_s}\nprofile=debug\nconfig=default detection thresholds\n",
            pages.len()
        ),
    )?;
    let modes = [
        Mode {
            name: "serial1",
            workers: 1,
            fixed: false,
            whole_stage_lock: true,
        },
        Mode {
            name: "current4",
            workers: 4,
            fixed: false,
            whole_stage_lock: true,
        },
        Mode {
            name: "rolling2",
            workers: 2,
            fixed: false,
            whole_stage_lock: false,
        },
        Mode {
            name: "fixed4",
            workers: 4,
            fixed: true,
            whole_stage_lock: false,
        },
        Mode {
            name: "rolling4",
            workers: 4,
            fixed: false,
            whole_stage_lock: false,
        },
        Mode {
            name: "serial1-repeat",
            workers: 1,
            fixed: false,
            whole_stage_lock: true,
        },
        Mode {
            name: "rolling4-repeat",
            workers: 4,
            fixed: false,
            whole_stage_lock: false,
        },
        Mode {
            name: "rolling6",
            workers: 6,
            fixed: false,
            whole_stage_lock: false,
        },
        Mode {
            name: "rolling8",
            workers: 8,
            fixed: false,
            whole_stage_lock: false,
        },
        Mode {
            name: "rolling6-repeat",
            workers: 6,
            fixed: false,
            whole_stage_lock: false,
        },
        Mode {
            name: "rolling8-repeat",
            workers: 8,
            fixed: false,
            whole_stage_lock: false,
        },
    ];
    let selected = std::env::var("DETECT_PROBE_MODES")
        .unwrap_or_else(|_| modes.iter().map(|m| m.name).collect::<Vec<_>>().join(","));
    let mut summary = fs::File::create(output.join("summary.tsv"))?;
    writeln!(
        summary,
        "mode\tworkers\twall_s\tdecode_sum_s\tinference_wait_sum_s\tinference_sum_s\tfinish_sum_s\tcommit_sum_s\tregions\tmatching_pages"
    )?;
    summary.flush()?;
    let mut baseline = None::<Vec<u64>>;
    for mode in modes
        .into_iter()
        .filter(|m| selected.split(',').any(|name| name == m.name))
    {
        let (mut session, ids) = import(&pages).await?;
        let snapshot = session.snapshot();
        let gate = mode
            .whole_stage_lock
            .then(|| Arc::new(tokio::sync::Mutex::new(())));
        let started = Instant::now();
        let mut sums = [0.0; 5];
        let mut digests = vec![0; pages.len()];
        let mut regions = 0;
        eprintln!(
            "START mode={} pages={} workers={}",
            mode.name,
            pages.len(),
            mode.workers
        );
        let group_size = if mode.fixed {
            mode.workers
        } else {
            pages.len()
        };
        for first in (0..pages.len()).step_by(group_size) {
            let end = (first + group_size).min(pages.len());
            let mut jobs = stream::iter(first..end)
                .map(|index| {
                    let input = StageInput::new(
                        snapshot.clone(),
                        ids[index],
                        None,
                        None,
                        Arc::new(crate::ImageCache::default()),
                        None,
                    );
                    let model = model.clone();
                    let gate = gate.clone();
                    async move { tokio::spawn(process(model, input, index, gate)).await? }
                })
                .buffer_unordered(mode.workers);
            while let Some(result) = jobs.next().await {
                let result: Completed = result?;
                let commit_started = Instant::now();
                let patch = result.patch.rebase_on(&session.snapshot())?;
                session.commit(patch).await?;
                let commit = commit_started.elapsed().as_secs_f64();
                let elapsed = started.elapsed().as_secs_f64();
                digests[result.index] = result.digest;
                regions += result.regions;
                for (sum, value) in sums.iter_mut().zip([
                    result.decode,
                    result.inference_wait,
                    result.inference,
                    result.finish,
                    commit,
                ]) {
                    *sum += value;
                }
                writeln!(
                    log,
                    "{}\t{}\t{:.6}\t{:.6}\t{:.6}\t{:.6}\t{:.6}\t{}\t{:016x}\t{elapsed:.6}",
                    mode.name,
                    pages[result.index].name,
                    result.decode,
                    result.inference_wait,
                    result.inference,
                    result.finish,
                    commit,
                    result.regions,
                    result.digest
                )?;
                log.flush()?;
                eprintln!(
                    "PAGE mode={} page={} infer={:.2}s cpu_finish={:.2}s elapsed={elapsed:.2}s",
                    mode.name, pages[result.index].name, result.inference, result.finish
                );
            }
        }
        let wall = started.elapsed().as_secs_f64();
        let matching = baseline.as_ref().map_or(pages.len(), |baseline| {
            baseline
                .iter()
                .zip(&digests)
                .filter(|(a, b)| a == b)
                .count()
        });
        writeln!(
            summary,
            "{}\t{}\t{wall:.6}\t{:.6}\t{:.6}\t{:.6}\t{:.6}\t{:.6}\t{regions}\t{matching}",
            mode.name, mode.workers, sums[0], sums[1], sums[2], sums[3], sums[4]
        )?;
        summary.flush()?;
        eprintln!(
            "FINISH mode={} wall={wall:.3}s matching={matching}/{} regions={regions}",
            mode.name,
            pages.len()
        );
        if baseline.is_none() {
            baseline = Some(digests);
        }
        ensure!(
            matching == pages.len(),
            "detection outputs differ from first mode"
        );
    }
    Ok(())
}
