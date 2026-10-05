use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::Path,
};

use serde::Serialize;

#[derive(Serialize)]
pub(super) struct PipelineTimingRecord {
    pub(super) job_id: String,
    pub(super) operation: koharu_pipeline::Operation,
    pub(super) outcome: String,
    pub(super) started_at_unix_ms: u128,
    pub(super) finished_at_unix_ms: u128,
    pub(super) wall_duration_ms: u128,
    pub(super) pipeline_duration_ms: Option<u128>,
    pub(super) page_count: usize,
    pub(super) stage_count: usize,
    pub(super) completed_steps: usize,
    pub(super) total_steps: usize,
    pub(super) error: Option<String>,
}

pub(super) fn append_record(path: &Path, record: &PipelineTimingRecord) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    serde_json::to_writer(&mut file, record).map_err(io::Error::other)?;
    file.write_all(b"\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_json_lines_for_completed_pipeline_runs() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("logs/pipeline-timings.jsonl");
        let record = PipelineTimingRecord {
            job_id: "job-1".into(),
            operation: koharu_pipeline::Operation::Through {
                stage: koharu_pipeline::Stage::Detection,
            },
            outcome: "completed".into(),
            started_at_unix_ms: 1_000,
            finished_at_unix_ms: 13_345,
            wall_duration_ms: 12_345,
            pipeline_duration_ms: Some(12_000),
            page_count: 26,
            stage_count: 1,
            completed_steps: 26,
            total_steps: 26,
            error: None,
        };

        append_record(&path, &record).unwrap();
        append_record(&path, &record).unwrap();

        let lines = std::fs::read_to_string(path).unwrap();
        let records = lines.lines().collect::<Vec<_>>();
        assert_eq!(records.len(), 2);
        let saved: serde_json::Value = serde_json::from_str(records[0]).unwrap();
        assert_eq!(saved["operation"]["stage"], "detection");
        assert_eq!(saved["wall_duration_ms"], 12_345);
        assert_eq!(saved["page_count"], 26);
        assert_eq!(saved["stage_count"], 1);
    }
}
