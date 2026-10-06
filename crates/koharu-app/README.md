# koharu-app

`koharu-app` owns Koharu's Tauri-managed application state, command API,
project lifecycle, processing jobs, typed channels, and agent host. It uses
`koharu-desktop` to prepare and publish page frames for the browser canvas.

Rust command signatures are the authoritative frontend contract:

```powershell
cargo run -p koharu-app --bin generate
```

## Pipeline timing log

Each completed, stopped, or failed job appends one JSON line to
`logs/pipeline-timings.jsonl` in the Koharu configuration directory. The
`page_stages` array records page number, page ID, stage, model, outcome, total
duration, and milliseconds spent waiting for the accelerator, recovering from
memory pressure, loading the model, processing the page, committing the
result, and in other stage-runner work. A failed stage is recorded with its
partial timings and error. Page-stage durations can overlap across pages, so
their sum is not the pipeline wall time.
