use std::sync::Arc;
use std::time::Duration;

use crate::Stage;
use koharu_scene::EntityId;

#[derive(Clone, Debug)]
pub enum Progress {
    Started {
        pages: Vec<EntityId>,
        stages: Vec<Stage>,
    },
    Loading {
        page: EntityId,
        stage: Stage,
        model: String,
    },
    Running {
        page: EntityId,
        stage: Stage,
        model: String,
    },
    Finished {
        page: EntityId,
        stage: Stage,
        model: String,
        elapsed: std::time::Duration,
        timing: StageTiming,
        commit_elapsed: Duration,
    },
    Skipped {
        page: EntityId,
        stage: Stage,
        model: String,
        elapsed: Duration,
        timing: StageTiming,
    },
    Failed {
        page: EntityId,
        stage: Stage,
        model: String,
        elapsed: Duration,
        timing: StageTiming,
        commit_elapsed: Duration,
        error: String,
    },
}

/// Time spent by one page and stage in its measurable pipeline phases.
#[derive(Clone, Copy, Debug, Default)]
pub struct StageTiming {
    pub accelerator_wait: Duration,
    pub recovery: Duration,
    pub model_load: Duration,
    pub process: Duration,
}

pub type ProgressSink = Arc<dyn Fn(Progress) + Send + Sync>;

pub(crate) fn emit(sink: Option<&ProgressSink>, progress: Progress) {
    if let Some(sink) = sink {
        sink(progress);
    }
}
