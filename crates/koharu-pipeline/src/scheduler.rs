use std::collections::BTreeMap;

use koharu_scene::EntityId;

use crate::Stage;

#[derive(Clone, Copy, Eq, PartialEq)]
enum WorkState {
    Pending,
    Running,
    Finished,
}

pub(crate) struct Scheduler {
    pages: Vec<EntityId>,
    page_index: BTreeMap<EntityId, usize>,
    stages: Vec<Stage>,
    page_states: Vec<WorkState>,
    stage_index: usize,
    page_workers: usize,
    active_workers: usize,
    total: usize,
}

impl Scheduler {
    pub(crate) fn new(pages: &[EntityId], stages: &[Stage], page_workers: usize) -> Self {
        let pages = pages.to_vec();
        let stages = stages.to_vec();
        Self {
            page_index: pages
                .iter()
                .enumerate()
                .map(|(index, page)| (*page, index))
                .collect(),
            page_states: vec![WorkState::Pending; pages.len()],
            total: pages.len().saturating_mul(stages.len()),
            pages,
            stages,
            stage_index: 0,
            page_workers: page_workers.max(1),
            active_workers: 0,
        }
    }

    pub(crate) fn total(&self) -> usize {
        self.total
    }

    pub(crate) fn start_next(&mut self) -> Option<(EntityId, Stage)> {
        loop {
            let stage = *self.stages.get(self.stage_index)?;
            if self.active_workers >= self.page_workers {
                return None;
            }

            if let Some((index, page)) = self
                .page_states
                .iter_mut()
                .enumerate()
                .find(|(_, state)| **state == WorkState::Pending)
            {
                *page = WorkState::Running;
                self.active_workers += 1;
                return Some((self.pages[index], stage));
            }

            if self.active_workers > 0 {
                return None;
            }

            self.stage_index += 1;
            self.page_states.fill(WorkState::Pending);
        }
    }

    /// Marks a page's current stage complete and returns true after its final stage.
    pub(crate) fn complete_stage(&mut self, page: EntityId, stage: Stage) -> bool {
        let Some(&page_index) = self.page_index.get(&page) else {
            return false;
        };
        if self.stages.get(self.stage_index) != Some(&stage)
            || self.page_states[page_index] != WorkState::Running
        {
            return false;
        }

        self.page_states[page_index] = WorkState::Finished;
        self.active_workers = self.active_workers.saturating_sub(1);
        self.stage_index + 1 == self.stages.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pages(count: usize) -> Vec<EntityId> {
        (0..count).map(|_| EntityId::new()).collect()
    }

    #[test]
    fn holds_a_global_stage_barrier_and_limits_active_pages() {
        let pages = pages(4);
        let stages = Stage::ALL;
        let mut scheduler = Scheduler::new(&pages, &stages, 2);

        assert_eq!(scheduler.start_next(), Some((pages[0], Stage::Detection)));
        assert_eq!(scheduler.start_next(), Some((pages[1], Stage::Detection)));
        assert_eq!(scheduler.start_next(), None);

        assert!(!scheduler.complete_stage(pages[1], Stage::Detection));
        assert_eq!(scheduler.start_next(), Some((pages[2], Stage::Detection)));
        assert!(!scheduler.complete_stage(pages[0], Stage::Detection));
        assert_eq!(scheduler.start_next(), Some((pages[3], Stage::Detection)));
        assert!(!scheduler.complete_stage(pages[2], Stage::Detection));
        assert!(!scheduler.complete_stage(pages[3], Stage::Detection));

        assert_eq!(scheduler.start_next(), Some((pages[0], Stage::Ocr)));
        assert_eq!(scheduler.start_next(), Some((pages[1], Stage::Ocr)));
        assert_eq!(scheduler.start_next(), None);
        assert!(!scheduler.complete_stage(pages[0], Stage::Ocr));
        assert_eq!(scheduler.start_next(), Some((pages[2], Stage::Ocr)));
        assert!(!scheduler.complete_stage(pages[1], Stage::Ocr));
        assert_eq!(scheduler.start_next(), Some((pages[3], Stage::Ocr)));
        assert!(!scheduler.complete_stage(pages[2], Stage::Ocr));
        assert!(!scheduler.complete_stage(pages[3], Stage::Ocr));

        assert_eq!(scheduler.start_next(), Some((pages[0], Stage::Inpainting)));
        assert_eq!(scheduler.start_next(), Some((pages[1], Stage::Inpainting)));
        assert_eq!(scheduler.start_next(), None);
        assert!(!scheduler.complete_stage(pages[0], Stage::Inpainting));
        assert_eq!(scheduler.start_next(), Some((pages[2], Stage::Inpainting)));
        assert!(!scheduler.complete_stage(pages[1], Stage::Inpainting));
        assert_eq!(scheduler.start_next(), Some((pages[3], Stage::Inpainting)));
        assert!(!scheduler.complete_stage(pages[2], Stage::Inpainting));
        assert!(!scheduler.complete_stage(pages[3], Stage::Inpainting));
        assert_eq!(scheduler.start_next(), Some((pages[0], Stage::Translation)));
    }

    #[test]
    fn final_stage_completion_marks_page_finished_and_empty_scopes_finish() {
        let pages = pages(1);
        let stages = [Stage::Detection, Stage::Translation];
        let mut scheduler = Scheduler::new(&pages, &stages, 8);

        assert_eq!(scheduler.start_next(), Some((pages[0], Stage::Detection)));
        assert!(!scheduler.complete_stage(pages[0], Stage::Detection));
        assert_eq!(scheduler.start_next(), Some((pages[0], Stage::Translation)));
        assert!(scheduler.complete_stage(pages[0], Stage::Translation));
        assert_eq!(scheduler.start_next(), None);

        let mut empty = Scheduler::new(&[], &stages, 2);
        assert_eq!(empty.start_next(), None);
        assert_eq!(empty.total(), 0);
    }
}
