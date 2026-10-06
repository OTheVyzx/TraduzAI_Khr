use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use anyhow::Result;
use koharu_scene::{EntityId, Patch};

use crate::{
    ErrorKind, PipelineConfig, PipelineError, Progress, ProgressSink, Stage, StageTiming,
    StopToken,
    accelerator::AcceleratorGate,
    progress,
    resources::ResourceMonitor,
    stages::{DETECTION_BATCH_SIZE, StageInput, Stages},
};

pub(crate) struct StageRunner {
    stages: Stages,
    accelerator: AcceleratorGate,
    page_workers: usize,
}

impl StageRunner {
    pub(crate) fn new(
        config: &PipelineConfig,
        translator: koharu_translator::Translator,
        device: &koharu_ml::Device,
        resources: Arc<ResourceMonitor>,
    ) -> Result<Self> {
        Ok(Self {
            stages: Stages::new(config, translator, device)?,
            accelerator: AcceleratorGate::new(device, resources),
            page_workers: config.page_workers.clamp(
                crate::config::MIN_PAGE_WORKERS,
                crate::config::MAX_PAGE_WORKERS,
            ) as usize,
        })
    }

    pub(crate) fn page_workers(&self) -> usize {
        self.page_workers
    }

    pub(crate) fn detection_batch_size(&self) -> usize {
        self.page_workers.min(DETECTION_BATCH_SIZE).max(1)
    }

    #[tracing::instrument(skip_all)]
    pub(crate) async fn run(&self, job: StageJob) -> StageCompletion {
        let started = Instant::now();
        let page = job.input.page();
        let model = self.stages.model(job.stage).to_owned();
        let mut timing = StageTiming::default();
        let outcome = self.run_with_recovery(&job, &model, &mut timing).await;
        StageCompletion {
            page,
            stage: job.stage,
            model,
            elapsed: started.elapsed(),
            timing,
            outcome,
        }
    }

    pub(crate) async fn run_detection_batches(
        &self,
        batches: Vec<Vec<StageJob>>,
    ) -> Vec<StageCompletion> {
        let model = self.stages.model(Stage::Detection).to_owned();
        let mut completed = Vec::new();
        let mut active_batches = Vec::new();
        for batch in batches {
            let mut active = Vec::new();
            for job in batch {
                let started = Instant::now();
                if job.stop.stopped() {
                    completed.push(completion(
                        &job,
                        model.clone(),
                        StageOutcome::Stopped,
                        Default::default(),
                        started.elapsed(),
                    ));
                    continue;
                }
                match self.stages.skip(Stage::Detection, &job.input) {
                    Ok(true) => completed.push(completion(
                        &job,
                        model.clone(),
                        StageOutcome::Skipped,
                        Default::default(),
                        started.elapsed(),
                    )),
                    Ok(false) => active.push(job),
                    Err(error) => {
                        self.stages.unload(Stage::Detection);
                        completed.push(failed_completion(
                            &job,
                            model,
                            StageTiming::default(),
                            started.elapsed(),
                            PipelineError::new(
                                ErrorKind::Processing,
                                Some(Stage::Detection),
                                error,
                            ),
                        ));
                        return completed;
                    }
                }
            }
            if !active.is_empty() {
                active_batches.push(active);
            }
        }
        if active_batches.is_empty() {
            return completed;
        }

        for job in active_batches.iter().flatten() {
            progress::emit(
                job.progress.as_ref(),
                Progress::Loading {
                    page: job.input.page(),
                    stage: Stage::Detection,
                    model: model.clone(),
                },
            );
        }
        let waiting = Instant::now();
        let mut permit = Some(self.accelerator.acquire().await);
        let wait = waiting.elapsed();
        let loading = Instant::now();
        if let Err(error) = self.stages.load(Stage::Detection).await {
            self.stages.unload(Stage::Detection);
            completed.push(failed_completion(
                &active_batches[0][0],
                model.clone(),
                StageTiming {
                    accelerator_wait: wait,
                    model_load: loading.elapsed(),
                    ..StageTiming::default()
                },
                wait + loading.elapsed(),
                PipelineError::new(
                    ErrorKind::ModelLoad,
                    Some(Stage::Detection),
                    error.context(format!("failed to load {model}")),
                ),
            ));
            return completed;
        }
        let model_load = loading.elapsed();
        for job in active_batches.iter().flatten() {
            progress::emit(
                job.progress.as_ref(),
                Progress::Running {
                    page: job.input.page(),
                    stage: Stage::Detection,
                    model: model.clone(),
                },
            );
        }

        let first_jobs = active_batches.remove(0);
        let first_started = Instant::now();
        let first_prepared = match self
            .stages
            .prepare_detection_batch(first_jobs.iter().map(|job| job.input.clone()).collect())
            .await
        {
            Ok(prepared) => prepared,
            Err(error) => {
                self.stages.unload(Stage::Detection);
                completed.push(failed_completion(
                    &first_jobs[0],
                    model,
                    StageTiming {
                        accelerator_wait: wait,
                        model_load,
                        ..StageTiming::default()
                    },
                    wait + model_load + first_started.elapsed(),
                    PipelineError::new(ErrorKind::Processing, Some(Stage::Detection), error),
                ));
                return completed;
            }
        };
        let mut current = (first_jobs, first_prepared, first_started);

        for next_jobs in active_batches {
            let next_started = Instant::now();
            let next_prepare = self
                .stages
                .prepare_detection_batch(next_jobs.iter().map(|job| job.input.clone()).collect());
            let process_current = self.stages.process_prepared_detection_batch(current.1);
            let (next_result, current_result) = tokio::join!(next_prepare, process_current);
            match current_result {
                Ok(patches) => append_batch_completions(
                    &mut completed,
                    current.0,
                    patches,
                    model.clone(),
                    StageTiming {
                        accelerator_wait: wait,
                        model_load,
                        process: current.2.elapsed(),
                        ..StageTiming::default()
                    },
                    wait + model_load + current.2.elapsed(),
                ),
                Err(error) if is_out_of_memory(&error) => {
                    drop(permit.take());
                    let recovery = Instant::now();
                    let recovery_permit = self
                        .accelerator
                        .recover(Stage::Detection, &self.stages)
                        .await;
                    let recovery_elapsed = recovery.elapsed();
                    drop(recovery_permit);
                    for job in current.0 {
                        let mut fallback = self.run(job).await;
                        fallback.timing.recovery += recovery_elapsed;
                        completed.push(fallback);
                    }
                    permit = Some(self.accelerator.acquire().await);
                }
                Err(error) => {
                    self.stages.unload(Stage::Detection);
                    completed.push(failed_completion(
                        &current.0[0],
                        model,
                        StageTiming {
                            accelerator_wait: wait,
                            model_load,
                            process: current.2.elapsed(),
                            ..StageTiming::default()
                        },
                        wait + model_load + current.2.elapsed(),
                        PipelineError::new(ErrorKind::Processing, Some(Stage::Detection), error),
                    ));
                    return completed;
                }
            }
            let next_prepared = match next_result {
                Ok(prepared) => prepared,
                Err(error) => {
                    self.stages.unload(Stage::Detection);
                    completed.push(failed_completion(
                        &next_jobs[0],
                        model,
                        StageTiming {
                            accelerator_wait: wait,
                            model_load,
                            ..StageTiming::default()
                        },
                        wait + model_load + next_started.elapsed(),
                        PipelineError::new(ErrorKind::Processing, Some(Stage::Detection), error),
                    ));
                    return completed;
                }
            };
            current = (next_jobs, next_prepared, next_started);
        }

        match self
            .stages
            .process_prepared_detection_batch(current.1)
            .await
        {
            Ok(patches) => append_batch_completions(
                &mut completed,
                current.0,
                patches,
                model.clone(),
                StageTiming {
                    accelerator_wait: wait,
                    model_load,
                    process: current.2.elapsed(),
                    ..StageTiming::default()
                },
                wait + model_load + current.2.elapsed(),
            ),
            Err(error) if is_out_of_memory(&error) => {
                drop(permit.take());
                let recovery = Instant::now();
                let recovery_permit = self
                    .accelerator
                    .recover(Stage::Detection, &self.stages)
                    .await;
                let recovery_elapsed = recovery.elapsed();
                drop(recovery_permit);
                for job in current.0 {
                    let mut fallback = self.run(job).await;
                    fallback.timing.recovery += recovery_elapsed;
                    completed.push(fallback);
                }
            }
            Err(error) => {
                self.stages.unload(Stage::Detection);
                completed.push(failed_completion(
                    &current.0[0],
                    model,
                    StageTiming {
                        accelerator_wait: wait,
                        model_load,
                        process: current.2.elapsed(),
                        ..StageTiming::default()
                    },
                    wait + model_load + current.2.elapsed(),
                    PipelineError::new(ErrorKind::Processing, Some(Stage::Detection), error),
                ));
                return completed;
            }
        }
        completed
    }

    async fn run_with_recovery(
        &self,
        job: &StageJob,
        model: &str,
        timing: &mut StageTiming,
    ) -> std::result::Result<StageOutcome, PipelineError> {
        if job.stop.stopped() {
            return Ok(StageOutcome::Stopped);
        }
        let skip = self.stages.skip(job.stage, &job.input).map_err(|error| {
            self.stage_error(
                job.stage,
                model,
                AttemptFailure {
                    kind: ErrorKind::Processing,
                    error,
                },
            )
        })?;
        if skip {
            return Ok(StageOutcome::Skipped);
        }
        let waiting = Instant::now();
        let permit = self.accelerator.acquire().await;
        timing.accelerator_wait += waiting.elapsed();
        if job.stop.stopped() {
            return Ok(StageOutcome::Stopped);
        }
        let first = self.load_and_process(job, model, timing).await;
        let failure = match first {
            Ok(outcome) => return Ok(outcome),
            Err(failure) if is_out_of_memory(&failure.error) && !job.stop.stopped() => failure,
            Err(failure) => return Err(self.stage_error(job.stage, model, failure)),
        };

        drop(permit);
        tracing::warn!(stage = %job.stage, page = %job.input.page(), error = %failure.error, "retrying stage after memory pressure");
        let _metric =
            tracing::info_span!(target: "koharu_metrics", "stage_retry", stage = %job.stage, model);
        let recovery = Instant::now();
        let _permit = self.accelerator.recover(job.stage, &self.stages).await;
        timing.recovery += recovery.elapsed();
        if job.stop.stopped() {
            return Ok(StageOutcome::Stopped);
        }
        match self.load_and_process(job, model, timing).await {
            Ok(outcome) => Ok(outcome),
            Err(failure) => Err(self.stage_error(job.stage, model, failure)),
        }
    }

    async fn load_and_process(
        &self,
        job: &StageJob,
        model: &str,
        timing: &mut StageTiming,
    ) -> std::result::Result<StageOutcome, AttemptFailure> {
        progress::emit(
            job.progress.as_ref(),
            Progress::Loading {
                page: job.input.page(),
                stage: job.stage,
                model: model.to_owned(),
            },
        );
        let loading = Instant::now();
        let loaded = self.stages.load(job.stage).await;
        timing.model_load += loading.elapsed();
        loaded.map_err(|error| AttemptFailure {
            kind: ErrorKind::ModelLoad,
            error,
        })?;
        if job.stop.stopped() {
            return Ok(StageOutcome::Stopped);
        }
        progress::emit(
            job.progress.as_ref(),
            Progress::Running {
                page: job.input.page(),
                stage: job.stage,
                model: model.to_owned(),
            },
        );
        let processing = Instant::now();
        let result = self.stages.process(job.stage, job.input.clone()).await;
        timing.process += processing.elapsed();
        result
            .map(|patch| {
                if patch.is_empty() {
                    StageOutcome::Skipped
                } else {
                    StageOutcome::Patch(patch)
                }
            })
            .map_err(|error| AttemptFailure {
                kind: ErrorKind::Processing,
                error,
            })
    }

    fn stage_error(&self, stage: Stage, model: &str, failure: AttemptFailure) -> PipelineError {
        self.stages.unload(stage);
        let message = match failure.kind {
            ErrorKind::ModelLoad => format!("failed to load {model}"),
            _ => format!("{model} failed"),
        };
        PipelineError::new(failure.kind, Some(stage), failure.error.context(message))
    }
}

struct AttemptFailure {
    kind: ErrorKind,
    error: anyhow::Error,
}

fn is_out_of_memory(error: &anyhow::Error) -> bool {
    error.chain().any(|source| {
        let message = source.to_string().to_ascii_lowercase();
        message.contains("out of memory")
            || message.contains("cuda_error_out_of_memory")
            || message.contains("not enough memory")
    })
}

pub(crate) struct StageJob {
    stage: Stage,
    input: StageInput,
    stop: StopToken,
    progress: Option<ProgressSink>,
}

impl StageJob {
    pub(crate) fn stage(&self) -> Stage {
        self.stage
    }
}

impl StageJob {
    pub(crate) fn new(
        stage: Stage,
        input: StageInput,
        stop: StopToken,
        progress: Option<ProgressSink>,
    ) -> Self {
        Self {
            stage,
            input,
            stop,
            progress,
        }
    }
}

pub(crate) enum StageOutcome {
    Patch(Patch),
    Skipped,
    Stopped,
}

pub(crate) struct StageCompletion {
    pub(crate) page: EntityId,
    pub(crate) stage: Stage,
    pub(crate) model: String,
    pub(crate) elapsed: Duration,
    pub(crate) timing: StageTiming,
    pub(crate) outcome: std::result::Result<StageOutcome, PipelineError>,
}

fn completion(
    job: &StageJob,
    model: String,
    outcome: StageOutcome,
    timing: StageTiming,
    elapsed: Duration,
) -> StageCompletion {
    StageCompletion {
        page: job.input.page(),
        stage: Stage::Detection,
        model,
        elapsed,
        timing,
        outcome: Ok(outcome),
    }
}

fn failed_completion(
    job: &StageJob,
    model: String,
    timing: StageTiming,
    elapsed: Duration,
    error: PipelineError,
) -> StageCompletion {
    StageCompletion {
        page: job.input.page(),
        stage: Stage::Detection,
        model,
        elapsed,
        timing,
        outcome: Err(error),
    }
}

fn append_batch_completions(
    completions: &mut Vec<StageCompletion>,
    jobs: Vec<StageJob>,
    patches: Vec<Patch>,
    model: String,
    timing: StageTiming,
    elapsed: Duration,
) {
    debug_assert_eq!(jobs.len(), patches.len());
    completions.extend(jobs.into_iter().zip(patches).map(|(job, patch)| {
        let outcome = if patch.is_empty() {
            StageOutcome::Skipped
        } else {
            StageOutcome::Patch(patch)
        };
        completion(&job, model.clone(), outcome, timing, elapsed)
    }));
}
