use std::{
    collections::HashMap,
    fmt,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context as _, Result};
use koharu_pipeline::{Committer, Progress, RunStatus, Stage, StageOutput, StageTiming, StopToken};
use koharu_scene::{EntityId, Snapshot};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager as _, State, ipc::Channel};
use tauri_runtime_cef::CefRuntime;
use uuid::Uuid;

use super::{ChannelExt as _, Error, canvas::CanvasChannel, project::CurrentProject};
use koharu_desktop::Desktop;

mod timing;

fn page_stage_timing(
    page: EntityId,
    page_number: Option<usize>,
    stage: Stage,
    model: Option<String>,
    outcome: &str,
    elapsed: Duration,
    stage_timing: StageTiming,
    commit_elapsed: Duration,
) -> timing::PageStageTiming {
    let measured = stage_timing.accelerator_wait
        + stage_timing.recovery
        + stage_timing.model_load
        + stage_timing.process;
    timing::PageStageTiming {
        page_number,
        page_id: page.to_string(),
        stage,
        model,
        outcome: outcome.to_owned(),
        duration_ms: elapsed.as_millis() + commit_elapsed.as_millis(),
        accelerator_wait_ms: stage_timing.accelerator_wait.as_millis(),
        recovery_ms: stage_timing.recovery.as_millis(),
        model_load_ms: stage_timing.model_load.as_millis(),
        process_ms: stage_timing.process.as_millis(),
        commit_ms: commit_elapsed.as_millis(),
        other_ms: elapsed.saturating_sub(measured).as_millis(),
    }
}

#[cfg(test)]
mod timing_tests {
    use super::*;

    #[test]
    fn page_timing_separates_stage_phases_and_commit() {
        let timing = page_stage_timing(
            EntityId::new(),
            Some(4),
            Stage::Ocr,
            Some("ocr-model".into()),
            "completed",
            Duration::from_millis(1_200),
            StageTiming {
                accelerator_wait: Duration::from_millis(100),
                recovery: Duration::ZERO,
                model_load: Duration::from_millis(200),
                process: Duration::from_millis(800),
            },
            Duration::from_millis(50),
        );

        assert_eq!(timing.page_number, Some(4));
        assert_eq!(timing.stage, Stage::Ocr);
        assert_eq!(timing.duration_ms, 1_250);
        assert_eq!(timing.accelerator_wait_ms, 100);
        assert_eq!(timing.model_load_ms, 200);
        assert_eq!(timing.process_ms, 800);
        assert_eq!(timing.commit_ms, 50);
        assert_eq!(timing.other_ms, 100);
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize, Type)]
#[serde(transparent)]
pub struct JobId(Uuid);

impl JobId {
    #[must_use]
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for JobId {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Display for JobId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

#[derive(Clone, Debug, Serialize, Type)]
pub struct Job {
    pub id: JobId,
    pub state: JobState,
    #[specta(type = f64)]
    pub completed: usize,
    #[specta(type = f64)]
    pub total: usize,
    pub page: Option<koharu_scene::EntityId>,
    pub stage: Option<koharu_pipeline::Stage>,
    pub model: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum JobState {
    Running,
    Finished,
    Failed,
    Stopped,
}

#[derive(Default)]
pub(crate) struct Processing {
    pub(crate) stops: Mutex<HashMap<JobId, StopToken>>,
    pub(crate) jobs: Mutex<HashMap<JobId, Job>>,
}

#[derive(Default)]
pub(crate) struct JobChannel {
    pub(crate) channel: Mutex<Option<Channel<Job>>>,
}

#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn process(
    handle: AppHandle<CefRuntime>,
    scope: koharu_pipeline::Scope,
    operation: koharu_pipeline::Operation,
    project: State<'_, CurrentProject>,
    processing: State<'_, Processing>,
    job_channel: State<'_, JobChannel>,
) -> std::result::Result<JobId, Error> {
    let snapshot = project
        .project
        .lock()
        .await
        .as_ref()
        .context("no project is open")?
        .snapshot();
    start_processing(
        handle,
        snapshot,
        scope,
        operation,
        None,
        processing.inner(),
        job_channel.inner(),
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn process_with_inpainting_mask(
    handle: AppHandle<CefRuntime>,
    page: EntityId,
    expected_size: [u32; 2],
    scope: koharu_pipeline::Scope,
    operation: koharu_pipeline::Operation,
    inpainting_mask: koharu_pipeline::InpaintingMask,
    project: &CurrentProject,
    processing: &Processing,
    job_channel: &JobChannel,
) -> std::result::Result<JobId, Error> {
    let snapshot = project
        .project
        .lock()
        .await
        .as_ref()
        .context("no project is open")?
        .snapshot();
    let size = snapshot.page(page)?.page()?;
    if [size.width.round() as u32, size.height.round() as u32] != expected_size {
        return Err(anyhow::anyhow!(
            "page dimensions changed while the canvas edit was in progress"
        )
        .into());
    }
    start_processing(
        handle,
        snapshot,
        scope,
        operation,
        Some(inpainting_mask),
        processing,
        job_channel,
    )
}

#[allow(clippy::too_many_arguments)]
fn start_processing(
    handle: AppHandle<CefRuntime>,
    snapshot: Snapshot,
    scope: koharu_pipeline::Scope,
    operation: koharu_pipeline::Operation,
    inpainting_mask: Option<koharu_pipeline::InpaintingMask>,
    processing: &Processing,
    job_channel: &JobChannel,
) -> std::result::Result<JobId, Error> {
    let id = JobId::new();
    let stop = StopToken::default();
    {
        let mut stops = processing.stops.lock();
        if !stops.is_empty() {
            return Err(anyhow::anyhow!("another process is already running").into());
        }
        stops.insert(id, stop.clone());
    }
    let job = Job {
        id,
        state: JobState::Running,
        completed: 0,
        total: 0,
        page: None,
        stage: None,
        model: None,
        error: None,
    };
    processing.jobs.lock().insert(id, job.clone());
    job_channel.channel.publish(job);

    let pipeline = handle.state::<koharu_pipeline::Pipeline>().inner().clone();
    let task_handle = handle.clone();
    let pipeline_started = Instant::now();
    let started_at_unix_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let logged_operation = operation.clone();
    let page_count = Arc::new(AtomicUsize::new(0));
    let stage_count = Arc::new(AtomicUsize::new(0));
    let page_numbers = Arc::new(Mutex::new(HashMap::<EntityId, usize>::new()));
    let page_stage_timings = Arc::new(Mutex::new(Vec::<timing::PageStageTiming>::new()));
    drop(tokio::spawn(async move {
        let progress = Arc::new(Mutex::new((0_usize, 0_usize)));
        let page_count_handle = page_count.clone();
        let stage_count_handle = stage_count.clone();
        let page_numbers_handle = page_numbers.clone();
        let page_stage_timings_handle = page_stage_timings.clone();
        let record_page_numbers_handle = page_numbers_handle.clone();
        let record_page_stage = move |page: EntityId,
                                      stage: Stage,
                                      model: Option<String>,
                                      outcome: &str,
                                      elapsed: Duration,
                                      stage_timing: StageTiming,
                                      commit_elapsed: Duration| {
            let page_number = record_page_numbers_handle.lock().get(&page).copied();
            page_stage_timings_handle.lock().push(page_stage_timing(
                page,
                page_number,
                stage,
                model,
                outcome,
                elapsed,
                stage_timing,
                commit_elapsed,
            ));
        };
        let progress_state = progress.clone();
        let progress_handle = task_handle.clone();
        let mut request = koharu_pipeline::Request {
            operation,
            scope,
            stop: stop.clone(),
            progress: None,
            inpainting_mask,
        };
        request.progress = Some(Arc::new(move |event| {
            let update = match event {
                Progress::Started { pages, stages } => {
                    page_count_handle.store(pages.len(), Ordering::Relaxed);
                    stage_count_handle.store(stages.len(), Ordering::Relaxed);
                    *page_numbers_handle.lock() = pages
                        .iter()
                        .copied()
                        .enumerate()
                        .map(|(index, page)| (page, index + 1))
                        .collect();
                    tracing::info!(
                        job = %id,
                        page_count = pages.len(),
                        stage_count = stages.len(),
                        "pipeline timing started",
                    );
                    tracing::info!(
                        target: "koharu_metrics",
                        metric = "pipeline_start",
                        page_count = pages.len(),
                        stage_count = stages.len(),
                    );
                    let mut progress = progress_state.lock();
                    *progress = (0, pages.len().saturating_mul(stages.len()));
                    Some((0, progress.1, None, None, None))
                }
                Progress::Loading { page, stage, model } => {
                    tracing::info!(
                        job = %id,
                        %page,
                        %stage,
                        %model,
                        "pipeline stage loading",
                    );
                    tracing::info!(
                        target: "koharu_metrics",
                        metric = "stage_loading",
                        stage = %stage,
                        model,
                    );
                    let progress = progress_state.lock();
                    Some((progress.0, progress.1, Some(page), Some(stage), Some(model)))
                }
                Progress::Finished {
                    page,
                    stage,
                    model,
                    elapsed,
                    timing,
                    commit_elapsed,
                } => {
                    record_page_stage(
                        page,
                        stage,
                        Some(model.clone()),
                        "completed",
                        elapsed,
                        timing,
                        commit_elapsed,
                    );
                    tracing::info!(
                        job = %id,
                        %page,
                        %stage,
                        %model,
                        duration_ms = (elapsed + commit_elapsed).as_secs_f64() * 1000.0,
                        accelerator_wait_ms = timing.accelerator_wait.as_secs_f64() * 1000.0,
                        recovery_ms = timing.recovery.as_secs_f64() * 1000.0,
                        model_load_ms = timing.model_load.as_secs_f64() * 1000.0,
                        process_ms = timing.process.as_secs_f64() * 1000.0,
                        commit_ms = commit_elapsed.as_secs_f64() * 1000.0,
                        "pipeline stage finished",
                    );
                    if stage != koharu_pipeline::Stage::Translation {
                        tracing::info!(
                            target: "koharu_metrics",
                            metric = "model_run",
                            stage = %stage,
                            model,
                            duration_ms = elapsed.as_secs_f64() * 1000.0,
                        );
                    }
                    let mut progress = progress_state.lock();
                    progress.0 = progress.0.saturating_add(1).min(progress.1);
                    Some((progress.0, progress.1, Some(page), Some(stage), Some(model)))
                }
                Progress::Skipped {
                    page,
                    stage,
                    model,
                    elapsed,
                    timing,
                } => {
                    record_page_stage(
                        page,
                        stage,
                        Some(model.clone()),
                        "skipped",
                        elapsed,
                        timing,
                        Duration::ZERO,
                    );
                    tracing::info!(
                        job = %id,
                        %page,
                        %stage,
                        %model,
                        duration_ms = elapsed.as_secs_f64() * 1000.0,
                        accelerator_wait_ms = timing.accelerator_wait.as_secs_f64() * 1000.0,
                        recovery_ms = timing.recovery.as_secs_f64() * 1000.0,
                        model_load_ms = timing.model_load.as_secs_f64() * 1000.0,
                        process_ms = timing.process.as_secs_f64() * 1000.0,
                        "pipeline stage skipped",
                    );
                    tracing::info!(
                        target: "koharu_metrics",
                        metric = "stage_skip",
                        stage = %stage,
                    );
                    let mut progress = progress_state.lock();
                    progress.0 = progress.0.saturating_add(1).min(progress.1);
                    Some((progress.0, progress.1, Some(page), Some(stage), Some(model)))
                }
                Progress::Failed {
                    page,
                    stage,
                    model,
                    elapsed,
                    timing,
                    commit_elapsed,
                    error,
                } => {
                    record_page_stage(
                        page,
                        stage,
                        Some(model.clone()),
                        "failed",
                        elapsed,
                        timing,
                        commit_elapsed,
                    );
                    tracing::error!(
                        job = %id,
                        %page,
                        %stage,
                        %model,
                        duration_ms = (elapsed + commit_elapsed).as_secs_f64() * 1000.0,
                        accelerator_wait_ms = timing.accelerator_wait.as_secs_f64() * 1000.0,
                        recovery_ms = timing.recovery.as_secs_f64() * 1000.0,
                        model_load_ms = timing.model_load.as_secs_f64() * 1000.0,
                        process_ms = timing.process.as_secs_f64() * 1000.0,
                        commit_ms = commit_elapsed.as_secs_f64() * 1000.0,
                        %error,
                        "pipeline stage failed",
                    );
                    let mut progress = progress_state.lock();
                    progress.0 = progress.0.saturating_add(1).min(progress.1);
                    Some((progress.0, progress.1, Some(page), Some(stage), Some(model)))
                }
                Progress::Running { page, stage, model } => {
                    tracing::info!(
                        job = %id,
                        %page,
                        %stage,
                        %model,
                        "pipeline stage started",
                    );
                    tracing::info!(
                        target: "koharu_metrics",
                        metric = "stage_running",
                        stage = %stage,
                        model,
                    );
                    None
                }
            };
            if let Some((completed, total, page, stage, model)) = update {
                let job = {
                    let processing = progress_handle.state::<Processing>();
                    let mut jobs = processing.jobs.lock();
                    jobs.get_mut(&id).map(|job| {
                        job.completed = completed;
                        job.total = total;
                        job.page = page;
                        job.stage = stage;
                        job.model = model;
                        job.clone()
                    })
                };
                if let Some(job) = job {
                    progress_handle.state::<JobChannel>().channel.publish(job);
                }
            }
        }));

        struct PipelineCommitter {
            handle: AppHandle<CefRuntime>,
        }

        #[async_trait::async_trait]
        impl Committer for PipelineCommitter {
            async fn commit(&mut self, output: StageOutput) -> Result<Snapshot> {
                let (commit, page) = {
                    let projects = self.handle.state::<CurrentProject>();
                    let mut projects = projects.project.lock().await;
                    let project = projects.as_mut().context("no project is open")?;
                    let Some(commit) = project.commit_rebased(output.patch).await? else {
                        return Ok(project.snapshot());
                    };
                    project.record_commit(&commit);
                    let page = project.active_page();
                    (commit, page)
                };
                let snapshot = commit.snapshot.clone();
                let desktop = self.handle.state::<Desktop>();
                desktop.synchronize(&commit.snapshot, page, &commit).await?;
                let canvas = desktop.canvas_state();
                self.handle.state::<CanvasChannel>().channel.publish(canvas);
                Ok(snapshot)
            }
        }

        let mut committer = PipelineCommitter {
            handle: task_handle.clone(),
        };
        let result = pipeline.execute(snapshot, request, &mut committer).await;
        let (stopped, error, pipeline_duration_ms, outcome) = match result {
            Ok(report) => {
                let stopped = report.status == RunStatus::Stopped;
                let outcome = if stopped { "stopped" } else { "completed" };
                tracing::info!(
                    job = %id,
                    outcome,
                    duration_ms = report.elapsed.as_secs_f64() * 1000.0,
                    wall_duration_ms = pipeline_started.elapsed().as_secs_f64() * 1000.0,
                    "pipeline timing finished",
                );
                (stopped, None, Some(report.elapsed.as_millis()), outcome)
            }
            Err(error) => {
                let error_message = format!("{error:#}");
                tracing::error!(stage = ?error.stage, error = %error_message, "processing failed");
                tracing::info!(
                    job = %id,
                    outcome = "failed",
                    duration_ms = pipeline_started.elapsed().as_secs_f64() * 1000.0,
                    "pipeline timing finished",
                );
                (false, Some(error_message), None, "failed")
            }
        };
        let wall_duration = pipeline_started.elapsed();
        let finished_at_unix_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let (completed_steps, total_steps) = *progress.lock();
        let timing_record = timing::PipelineTimingRecord {
            job_id: id.to_string(),
            operation: logged_operation,
            outcome: outcome.to_owned(),
            started_at_unix_ms,
            finished_at_unix_ms,
            wall_duration_ms: wall_duration.as_millis(),
            pipeline_duration_ms,
            page_count: page_count.load(Ordering::Relaxed),
            stage_count: stage_count.load(Ordering::Relaxed),
            completed_steps,
            total_steps,
            page_stages: page_stage_timings.lock().clone(),
            error: error.clone(),
        };
        let timing_path = koharu_config::path().and_then(|config_path| {
            config_path
                .parent()
                .map(|directory| directory.join("logs").join("pipeline-timings.jsonl"))
                .context("Koharu configuration path has no parent directory")
        });
        match timing_path {
            Ok(path) => {
                match tokio::task::spawn_blocking(move || {
                    timing::append_record(&path, &timing_record)
                })
                .await
                {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => {
                        tracing::error!(%error, "failed to write pipeline timing log")
                    }
                    Err(error) => tracing::error!(%error, "pipeline timing log task failed"),
                }
            }
            Err(error) => tracing::error!(%error, "failed to resolve pipeline timing log path"),
        }
        tracing::info!(
            target: "koharu_metrics",
            metric = "pipeline_result",
            outcome,
            duration_ms = wall_duration.as_secs_f64() * 1000.0,
        );
        task_handle.state::<Processing>().stops.lock().remove(&id);
        let job = task_handle
            .state::<Processing>()
            .jobs
            .lock()
            .remove(&id)
            .map(|mut job| {
                job.state = if stopped {
                    JobState::Stopped
                } else if error.is_some() {
                    JobState::Failed
                } else {
                    JobState::Finished
                };
                job.error = error;
                job
            });
        if let Some(job) = job {
            task_handle.state::<JobChannel>().channel.publish(job);
        }
    }));
    Ok(id)
}

#[tracing::instrument(
    target = "koharu_metrics",
    name = "pipeline_stop",
    skip_all,
    fields(state = "requested")
)]
#[tauri::command]
#[specta::specta]
pub(crate) async fn stop_job(
    job: JobId,
    processing: State<'_, Processing>,
) -> std::result::Result<(), Error> {
    let stops = processing.stops.lock();
    let stop = stops
        .get(&job)
        .with_context(|| format!("job {job} is not running"))?;
    stop.stop();
    Ok(())
}
