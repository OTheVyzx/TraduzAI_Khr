use std::{collections::BTreeMap, sync::Arc, time::Instant};

use anyhow::{Context as _, Result, ensure};
use futures::{StreamExt as _, stream::FuturesUnordered};
use koharu_scene::{EntityId, Snapshot};

use crate::{
    Committer, ErrorKind, PipelineError, Progress, ProgressSink, Report, Request, RunStatus, Stage,
    StageOutput, StopToken,
    images::ImageCache,
    progress,
    resources::ResourceMonitor,
    scheduler::Scheduler,
    scope::NormalizedScope,
    stage_runner::{StageCompletion, StageJob, StageOutcome, StageRunner},
    stages::StageInput,
};

pub(crate) struct Execution<'a> {
    runner: Arc<StageRunner>,
    resources: Arc<ResourceMonitor>,
    committer: &'a mut dyn Committer,
    stop: StopToken,
    progress: Option<ProgressSink>,
    scope: NormalizedScope,
    scheduler: Scheduler,
    scene: Snapshot,
    images: BTreeMap<EntityId, Arc<ImageCache>>,
    completed: usize,
    failure: Option<PipelineError>,
    base: koharu_scene::Revision,
    started: Instant,
    inpainting_mask: Option<crate::InpaintingMask>,
}

impl<'a> Execution<'a> {
    pub(crate) fn new(
        runner: Arc<StageRunner>,
        resources: Arc<ResourceMonitor>,
        snapshot: Snapshot,
        request: Request,
        committer: &'a mut dyn Committer,
    ) -> std::result::Result<Self, PipelineError> {
        let started = Instant::now();
        let base = snapshot.revision();
        let page_workers = runner.page_workers();
        let stages = request
            .operation
            .stages()
            .map_err(|error| PipelineError::new(ErrorKind::InvalidInput, None, error))?;
        let scope = NormalizedScope::new(&snapshot, &request.scope, &stages)
            .map_err(|error| PipelineError::new(ErrorKind::InvalidInput, None, error))?;
        let pages = scope.pages().to_vec();
        if let Some(mask) = request.inpainting_mask.as_ref()
            && (!pages.contains(&mask.page) || !stages.contains(&Stage::Inpainting))
        {
            return Err(PipelineError::new(
                ErrorKind::InvalidInput,
                Some(Stage::Inpainting),
                anyhow::anyhow!("the inpainting mask page is outside the inpainting scope"),
            ));
        }
        progress::emit(
            request.progress.as_ref(),
            Progress::Started {
                pages: pages.clone(),
                stages: stages.clone(),
            },
        );

        Ok(Self {
            runner,
            resources,
            committer,
            stop: request.stop,
            progress: request.progress,
            scope,
            scheduler: Scheduler::new(&pages, &stages, page_workers),
            scene: snapshot,
            images: BTreeMap::new(),
            completed: 0,
            failure: None,
            base,
            started,
            inpainting_mask: request.inpainting_mask,
        })
    }

    pub(crate) async fn run(mut self) -> std::result::Result<Report, PipelineError> {
        if self.stopped() {
            return Ok(self.report(RunStatus::Stopped));
        }

        self.resources.start();
        self.resources.wait_for_sample().await;

        let mut running = FuturesUnordered::new();
        loop {
            while let Some(job) = self.take_ready_job() {
                if job.stage() == Stage::Detection {
                    let batch_size = self.runner.detection_batch_size();
                    let active_limit = batch_size.saturating_mul(2);
                    let mut first = vec![job];
                    first.extend(self.take_ready_jobs(batch_size.saturating_sub(1), active_limit));
                    let second = self.take_ready_jobs(batch_size, active_limit);
                    let runner = self.runner.clone();
                    let mut batches = vec![first];
                    if !second.is_empty() {
                        batches.push(second);
                    }
                    running.push(tokio::spawn(async move {
                        runner.run_detection_batches(batches).await
                    }));
                } else {
                    let runner = self.runner.clone();
                    running.push(tokio::spawn(async move { vec![runner.run(job).await] }));
                }
            }

            let Some(completion) = running.next().await else {
                break;
            };
            let completions = match completion {
                Ok(completion) => completion,
                Err(error) => {
                    self.failure = Some(PipelineError::new(
                        ErrorKind::Processing,
                        None,
                        anyhow::anyhow!("pipeline worker task failed: {error}"),
                    ));
                    continue;
                }
            };
            for completion in completions {
                if self.stopped() || self.failure.is_some() {
                    continue;
                }
                if let Err(error) = self.apply_completion(completion).await {
                    self.failure = Some(error);
                }
            }
        }

        self.finalize()
    }

    fn take_ready_job(&mut self) -> Option<StageJob> {
        if self.stopped() || self.failure.is_some() {
            return None;
        }
        let (page, stage) = self.scheduler.start_next()?;
        Some(self.make_job(page, stage))
    }

    fn take_ready_jobs(&mut self, batch_limit: usize, active_limit: usize) -> Vec<StageJob> {
        if self.stopped() || self.failure.is_some() {
            return Vec::new();
        }
        self.scheduler
            .start_next_batch(batch_limit, active_limit)
            .into_iter()
            .map(|(page, stage)| self.make_job(page, stage))
            .collect()
    }

    fn make_job(&mut self, page: EntityId, stage: Stage) -> StageJob {
        let images = self
            .images
            .entry(page)
            .or_insert_with(|| Arc::new(ImageCache::default()))
            .clone();
        StageJob::new(
            stage,
            StageInput::new(
                self.scene.clone(),
                page,
                self.scope.entities(),
                self.scope.region(page),
                images,
                self.inpainting_mask
                    .as_ref()
                    .filter(|mask| stage == Stage::Inpainting && mask.page == page)
                    .cloned(),
            ),
            self.stop.clone(),
            self.progress.clone(),
        )
    }

    async fn apply_completion(
        &mut self,
        completion: StageCompletion,
    ) -> std::result::Result<(), PipelineError> {
        let StageCompletion {
            page,
            stage,
            model,
            elapsed,
            timing,
            outcome,
        } = completion;
        let outcome = match outcome {
            Ok(outcome) => outcome,
            Err(error) => {
                progress::emit(
                    self.progress.as_ref(),
                    Progress::Failed {
                        page,
                        stage,
                        model,
                        elapsed,
                        timing,
                        commit_elapsed: std::time::Duration::ZERO,
                        error: format!("{error:#}"),
                    },
                );
                return Err(error);
            }
        };
        match outcome {
            StageOutcome::Stopped => {}
            StageOutcome::Skipped => {
                self.mark_complete(page, stage);
                progress::emit(
                    self.progress.as_ref(),
                    Progress::Skipped {
                        page,
                        stage,
                        model,
                        elapsed,
                        timing,
                    },
                );
            }
            StageOutcome::Patch(patch) => {
                let committing = std::time::Instant::now();
                let commit_elapsed = match self.commit_patch(page, stage, patch).await {
                    Ok(true) => committing.elapsed(),
                    Ok(false) => return Ok(()),
                    Err(error) => {
                        progress::emit(
                            self.progress.as_ref(),
                            Progress::Failed {
                                page,
                                stage,
                                model,
                                elapsed,
                                timing,
                                commit_elapsed: committing.elapsed(),
                                error: format!("{error:#}"),
                            },
                        );
                        return Err(error);
                    }
                };
                self.mark_complete(page, stage);
                progress::emit(
                    self.progress.as_ref(),
                    Progress::Finished {
                        page,
                        stage,
                        model,
                        elapsed,
                        timing,
                        commit_elapsed,
                    },
                );
            }
        }
        Ok(())
    }

    async fn commit_patch(
        &mut self,
        page: EntityId,
        stage: Stage,
        patch: koharu_scene::Patch,
    ) -> std::result::Result<bool, PipelineError> {
        let patch = patch
            .rebase_on(&self.scene)
            .and_then(|patch| {
                patch.validate_on(&self.scene)?;
                Ok(patch.with_label(format!("Pipeline {stage} for page {page}")))
            })
            .context("failed to rebase stage output onto the latest scene")
            .map_err(|error| PipelineError::new(ErrorKind::InvalidOutput, Some(stage), error))?;
        if self.stopped() {
            return Ok(false);
        }

        let next = self
            .committer
            .commit(StageOutput { page, stage, patch })
            .await
            .with_context(|| format!("failed to commit {stage} output for page {page}"))
            .map_err(|error| PipelineError::new(ErrorKind::Commit, Some(stage), error))?;
        validate_commit(&self.scene, &next)
            .map_err(|error| PipelineError::new(ErrorKind::Commit, Some(stage), error))?;
        self.scene = next;
        Ok(true)
    }

    fn mark_complete(&mut self, page: EntityId, stage: Stage) {
        self.scheduler.complete_stage(page, stage);
        // Keep decoded source pages bounded by the active worker count instead
        // of retaining the entire chapter between stage barriers.
        self.images.remove(&page);
        self.completed += 1;
    }

    fn stopped(&self) -> bool {
        self.stop.stopped()
    }

    fn finalize(mut self) -> std::result::Result<Report, PipelineError> {
        if let Some(error) = self.failure.take() {
            return Err(error);
        }
        if !self.stopped() && self.completed != self.scheduler.total() {
            return Err(PipelineError::new(
                ErrorKind::InvalidOutput,
                None,
                anyhow::anyhow!(
                    "pipeline scheduler stopped after {} of {} work items",
                    self.completed,
                    self.scheduler.total()
                ),
            ));
        }
        let status = if self.stopped() {
            RunStatus::Stopped
        } else {
            RunStatus::Completed
        };
        Ok(self.report(status))
    }

    fn report(&self, status: RunStatus) -> Report {
        Report {
            status,
            base: self.base,
            final_revision: self.scene.revision(),
            completed: self.completed,
            total: self.scheduler.total(),
            elapsed: self.started.elapsed(),
        }
    }
}

fn validate_commit(previous: &Snapshot, next: &Snapshot) -> Result<()> {
    ensure!(
        previous.project_id() == next.project_id(),
        "committer returned a snapshot from another project"
    );
    ensure!(
        next.revision() > previous.revision(),
        "committer did not advance the scene revision"
    );
    Ok(())
}
