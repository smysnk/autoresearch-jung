# Experiment Atlas Live Monitoring Report

## Goal

Define a live monitoring design for `experiment-atlas` that can show an in-progress experiment without changing the runner-managed protocol or materially affecting training performance.

The current protocol is no longer just "launch `train.py` and watch stdout". It is a Jungian runner loop:

1. local Codex CLI runs the `prepare` phase from `program.md`
2. the runner commits and deploys the candidate
3. the remote Pod executes training
4. artifacts come back locally
5. local Codex CLI runs the `reflect` phase from `program.md`
6. the runner commits the resulting state and materializes the canonical session log

The intended topology is:

1. the local runner invokes Codex CLI `prepare`
2. the runner writes `research_state/current_iteration.json`
3. the runner deploys to the Runpod Pod
4. the Pod exposes live training telemetry
5. `experiment-atlas` consumes both runner-phase state and Pod live state
6. the runner retrieves artifacts and invokes Codex CLI `reflect`
7. the runner materializes `experiment_logs/<session-id>/iterations/<n>/`
8. the dashboard renders both the live runtime state and the eventual canonical record

The key constraint is that live monitoring must remain observational only. It must not change:

- the Codex `prepare` / `reflect` contract in `program.md`
- the runner-owned git / commit / push / keep-discard responsibilities
- the 5-minute training budget
- the final evaluation path
- the model update schedule
- the dataloader behavior
- the keep / discard decision surface

## What The Current Code Already Exposes

### `train.py`

The current training script already computes nearly all of the high-value live metrics at step granularity.

Relevant hook points:

- startup metadata and model config are finalized around [train.py](/Users/josh/play/autoresearch/train.py#L513)
- optimizer schedule state is computed inside the main loop around [train.py](/Users/josh/play/autoresearch/train.py#L610)
- per-step metrics are assembled around [train.py](/Users/josh/play/autoresearch/train.py#L637)
- the live training log line is printed at [train.py](/Users/josh/play/autoresearch/train.py#L646)
- final evaluation begins at [train.py](/Users/josh/play/autoresearch/train.py#L666)
- final summary is printed at [train.py](/Users/josh/play/autoresearch/train.py#L677)

The existing step log already includes:

- `step`
- `% done`
- smoothed train loss
- LR multiplier
- step duration
- tokens per second
- MFU estimate
- dataloader epoch
- remaining training time

The final summary already includes:

- `val_bpb`
- `training_seconds`
- `total_seconds`
- `peak_vram_mb`
- `mfu_percent`
- `total_tokens_M`
- `num_steps`
- `num_params_M`
- `depth`

### `prepare.py`

`prepare.py` matters for live monitoring mostly because it defines what must remain untouched:

- the fixed training budget at [prepare.py](/Users/josh/play/autoresearch/prepare.py#L31)
- the fixed validation evaluation path at [prepare.py](/Users/josh/play/autoresearch/prepare.py#L343)
- the dataloader packing behavior at [prepare.py](/Users/josh/play/autoresearch/prepare.py#L276)

Important implications:

- do not introduce extra validation passes during training
- do not add instrumentation that changes dataloader packing or GPU synchronization frequency
- do not add metrics that require additional forward or backward passes

### `runpod_runner.py`

The current Runpod flow is now both artifact-oriented and phase-oriented:

- the runner creates or reuses one Pod for the configured experiment batch
- before each experiment, it invokes local Codex CLI `prepare`
- it commits and pushes locally, refreshes the Pod checkout, and runs `train.py`
- monitoring is still polling and SCP-based for the canonical artifacts
- after each experiment, it syncs the exact remote `train.py` back locally
- it then invokes local Codex CLI `reflect`
- finally, it materializes `experiment_logs/<session-id>/iterations/<n>/` and creates the round commit

That means live dashboard support should not only stream the Pod. It should also understand the runner phases surrounding the Pod execution.

### `program.md`, `codex_agent.py`, and `experiment_log.py`

The live monitoring design now needs to respect three local control surfaces:

- `program.md` defines a two-phase psyche: `prepare` and `reflect`
- `scripts/codex_agent.py` is the local Codex CLI bridge used by both runners
- `scripts/experiment_log.py` materializes the canonical visualizer-ready record from `research_state/current_iteration.json`

Important implications:

- live UX should expose the current runner phase, not only the training phase
- active tensions and transcendent-function candidates already exist before training starts
- the post-run meaning of an iteration is not complete until `reflect` finishes
- `research_state/codex/...` transcripts are debug artifacts, not canonical history
- Atlas should capture what Codex changed during `prepare` and `reflect`, not only the final run metrics

## Safe Live Metrics

These are metrics that can be streamed live with negligible or no protocol impact because the training loop already computes them or they can be sampled out-of-band.

### Safe From Inside `train.py`

These are already present in-process and should be emitted only after they are already computed:

- `step`
- `epoch`
- `progress_pct`
- `training_seconds_elapsed`
- `remaining_seconds`
- `train_loss_raw`
- `train_loss_ema`
- `lr_multiplier`
- `muon_momentum`
- `muon_weight_decay`
- `step_dt_ms`
- `tokens_per_second`
- `mfu_percent_instant`
- `total_tokens_seen`
- `grad_accum_steps`
- `device_batch_size`
- `total_batch_size`
- `attention_backend`
- `window_pattern`
- `depth`
- `num_params`
- `estimated_flops_per_token`

These may also be safely read at low cadence from CUDA without affecting protocol:

- `torch.cuda.memory_allocated()`
- `torch.cuda.memory_reserved()`
- `torch.cuda.max_memory_allocated()`
- `torch.cuda.max_memory_reserved()`

These should be sampled after the existing `torch.cuda.synchronize()` block, not by adding new synchronizations.

### Safe From The Runner-Managed Local State

These are already present before or after the training loop and should be surfaced by Atlas without waiting for final archival:

- `session_id`
- `branch`
- `experiment_index`
- `runner_mode`
- `runner_phase` such as `prepare`, `deploy`, `train`, `artifact_sync`, `reflect`, `commit`
- `prediction`
- `move_type`
- `why_now`
- thesis summary
- antithesis summary
- active tension ids and labels
- transcendent-function candidate
- `prepare` modified files
- `prepare` diff summary
- `prepare` `train.py` patch or snapshot reference
- `prepare` `research_state/current_iteration.json` patch or snapshot reference
- post-run `keep_discard_status`
- post-run `framing_diagnosis`
- post-run transcendent result
- `reflect` modified files
- `reflect` diff summary
- `reflect` patch or snapshot references
- Codex last-message summaries for both `prepare` and `reflect`

These should come from `research_state/current_iteration.json` during staging and from `experiment_logs/...` after materialization, not from the training process itself.

Recommended capture shape:

- before `prepare`, snapshot the local files relevant to the iteration
- after `prepare`, compute a structured changed-files manifest and file diffs
- before `reflect`, snapshot the local dialectical files again
- after `reflect`, compute the second changed-files manifest and file diffs

For Atlas, the important surface is not the raw full transcript. It is:

- what files changed
- what the patch looked like
- what Codex said it was trying to do
- how that relates to the active tensions and transcendent movement

### Safe From A Sidecar Process On The Pod

These should not be gathered by `train.py` itself. They should be polled by the websocket relay process or a sibling telemetry sampler:

- GPU utilization
- GPU memory utilization
- temperature
- power draw
- Pod uptime
- websocket client count
- relay queue depth

These can come from `nvidia-smi` or a lightweight system probe every 2-5 seconds. They do not alter the training code path.

## Metrics To Avoid

These should not be added to live monitoring because they would change performance characteristics or the experiment protocol:

- mid-run `val_bpb`
- extra `evaluate_bpb(...)` calls
- gradient norm across all parameters every step
- parameter histograms
- activation histograms
- per-layer timings requiring new synchronization points
- full dataloader packing statistics per document
- profiler traces during normal experiments
- checkpointing solely for dashboard support
- any dashboard action that mutates `research_state/current_iteration.json`
- any dashboard action that triggers git, deployment, or keep/discard behavior directly
- treating pre-reflect live state as canonical outcome

The most important hard boundary is this:

- `evaluate_bpb(...)` in [prepare.py](/Users/josh/play/autoresearch/prepare.py#L343) is the fixed evaluation contract.
- it should remain final-only.
- `program.md` is the reflective contract for Codex CLI.
- it should remain runner-invoked, not dashboard-driven.

## Recommended Architecture

Use a **hybrid live architecture**:

- a local runner event stream for `prepare` / deploy / `reflect` / commit phases
- a separate websocket relay process on the Pod for in-training telemetry
- the existing disk artifact flow for canonical archival
- a local patch-capture layer for Codex `prepare` and `reflect` modifications

Recommended data flow:

1. local Codex CLI completes `prepare`
2. the runner snapshots the staged dialectical state
3. `train.py` emits structured step events locally on the Pod
4. a relay process on the Pod receives them
5. the relay enriches them with out-of-band GPU telemetry
6. the runner captures `prepare` diffs and emits them as structured patch events
7. the runner emits lifecycle events such as `deploy_started`, `train_started`, `artifact_sync_started`, `reflect_started`, `commit_completed`
8. after artifacts return, the runner captures `reflect` diffs and emits them as structured patch events
9. Atlas merges runner events, patch events, and Pod telemetry into one live experiment view
10. the runner materializes the final `experiment_logs/...` iteration and Atlas reconciles the live view with the canonical record

This keeps network I/O, reconnect logic, client fanout, and runner state transitions out of the training process.

### Why This Is Better Than Parsing `run.log` Alone

Parsing `run.log` is the lowest-risk fallback, but it has limitations:

- the current training line is carriage-return based, not structured
- it only exposes the metrics already in the text line
- it is awkward for phase transitions like `eval_started`
- it cannot cleanly mix in GPU telemetry

It is still worth keeping as a backup path, but not as the primary live protocol.

### Recommended Local Emitter Inside `train.py`

Inside `train.py`, use a no-op-by-default emitter that only activates when env vars are present.

Properties:

- best-effort only
- non-blocking
- bounded queue
- drop-on-backpressure
- never raises into the training loop
- no retries from the training thread

Preferred transport from `train.py` to the local relay:

1. **Unix datagram socket**: lowest overhead, no file tailing
2. **append-only JSONL file**: simpler fallback, still acceptable

If simplicity wins, JSONL is acceptable. If performance isolation is the priority, Unix datagrams are better.

## Websocket Relay Placement

The relay should be started alongside the training run by the Runpod launcher, not manually.

Suggested changes:

- expose a websocket port in `RunpodConfig.ports` in [scripts/runpod_runner.py](/Users/josh/play/autoresearch/scripts/runpod_runner.py#L263)
- launch the relay before `train.py` inside the remote execution script written by [scripts/runpod_runner.py](/Users/josh/play/autoresearch/scripts/runpod_runner.py#L1242)
- keep the existing `run.log` path unchanged for archival and post-run summaries

Operationally:

1. start websocket relay in the Pod
2. start a lightweight GPU telemetry sampler in the relay process
3. start `train.py`
4. broadcast `run_started`
5. broadcast `train_step` events
6. broadcast `eval_started`
7. broadcast `run_summary`
8. broadcast `run_finished` or `run_failed`

## How Experiment Atlas Should Connect

Preferred connection mode:

1. `experiment-atlas` server-side code reads local runner-phase state and session-log state
2. Atlas server-side code also connects to the Pod websocket when a run is actively training
3. Atlas normalizes both sources into one in-memory experiment state
4. Atlas serves that merged state to browser clients

This is preferable to direct browser-to-Pod websocket connections because it avoids:

- exposing ephemeral Pod addresses to the browser
- CORS and auth problems
- reconnect logic scattered across clients
- dashboard breakage when the Pod address changes
- loss of the local Codex / Jungian context before and after training

Direct browser connection is acceptable for local development only.

## Suggested Event Schema

Use a small event protocol with explicit event types.

### `run_started`

Emit once after remote setup is complete and before the first optimization step.

Suggested payload:

```json
{
  "type": "run_started",
  "execution_id": "20260312T023301Z-autoresearch",
  "session_id": "codex-transcendent-fn-mar12-0657",
  "branch": "codex/transcendent/fn-mar12-0657",
  "runner_phase": "train",
  "attention_backend": "flash",
  "time_budget_s": 300,
  "device_batch_size": 128,
  "total_batch_size": 524288,
  "grad_accum_steps": 2,
  "config": {
    "sequence_len": 2048,
    "n_layer": 8,
    "n_head": 4,
    "n_embd": 512,
    "window_pattern": "SSSL"
  },
  "param_counts": {
    "total": 50332176
  }
}
```

### `iteration_prepared`

Emit once after local Codex `prepare` completes and before deployment begins.

Suggested payload:

```json
{
  "type": "iteration_prepared",
  "session_id": "codex-transcendent-fn-mar12-0657",
  "branch": "codex/transcendent/fn-mar12-0657",
  "experiment_index": 3,
  "runner_phase": "prepare_complete",
  "prediction": "Reducing depth slightly will improve throughput enough to win back loss.",
  "move_type": "synthesize",
  "thesis": "Depth still carries useful quality.",
  "antithesis": "Throughput is the dominant constraint in a 5-minute run.",
  "prepare_changes": {
    "modified_files": [
      "train.py",
      "research_state/current_iteration.json"
    ],
    "summary": "Lower depth by one and stage a synthesis candidate around FFN width.",
    "patch_refs": {
      "train_py": "live/prepare/train.diff.patch",
      "research_state": "live/prepare/research-state.diff.patch"
    }
  },
  "active_tensions": [
    {
      "id": "depth-vs-throughput",
      "label": "Depth vs throughput",
      "favored_side": "antithesis"
    }
  ],
  "transcendent_candidate": {
    "emergent_thought": "Trade one layer for wider FFN capacity.",
    "tested_in_iteration": true
  }
}
```

### `train_step`

Emit at step cadence, but preferably throttled to every 1 second or every N steps.

Suggested payload:

```json
{
  "type": "train_step",
  "execution_id": "20260312T023301Z-autoresearch",
  "step": 412,
  "epoch": 1,
  "progress_pct": 43.5,
  "training_seconds_elapsed": 130.6,
  "remaining_seconds": 169.4,
  "train_loss_raw": 2.9134,
  "train_loss_ema": 2.9042,
  "lr_multiplier": 0.72,
  "muon_momentum": 0.95,
  "muon_weight_decay": 0.11,
  "step_dt_ms": 321,
  "tokens_per_second": 1634000,
  "mfu_percent_instant": 39.5,
  "total_tokens_seen": 216006656,
  "cuda": {
    "memory_allocated_mb": 44910.7,
    "memory_reserved_mb": 45211.0,
    "max_memory_allocated_mb": 45060.2
  },
  "gpu": {
    "util_percent": 96,
    "mem_util_percent": 88,
    "temp_c": 71,
    "power_w": 627
  }
}
```

### `eval_started`

Emit once immediately before the fixed final evaluation begins.

Suggested payload:

```json
{
  "type": "eval_started",
  "execution_id": "20260312T023301Z-autoresearch",
  "step": 948,
  "training_seconds_elapsed": 300.3
}
```

### `run_summary`

Emit once after the final summary has been computed.

Suggested payload:

```json
{
  "type": "run_summary",
  "execution_id": "20260312T023301Z-autoresearch",
  "val_bpb": 0.995650,
  "training_seconds": 300.3,
  "total_seconds": 354.8,
  "peak_vram_mb": 45060.2,
  "mfu_percent": 39.57,
  "total_tokens_M": 497.0,
  "num_steps": 948,
  "num_params_M": 50.3,
  "depth": 8
}
```

### `reflection_completed`

Emit once after local Codex `reflect` completes and before the runner creates the post-run commit.

Suggested payload:

```json
{
  "type": "reflection_completed",
  "session_id": "codex-transcendent-fn-mar12-0657",
  "branch": "codex/transcendent/fn-mar12-0657",
  "experiment_index": 3,
  "runner_phase": "reflect_complete",
  "outcome": "mixed",
  "contradicted_assumption": "The deeper variant was assumed to dominate despite lower throughput.",
  "keep_discard_status": "discard",
  "framing_diagnosis": "The idea may still be alive, but the current framing overpaid for depth.",
  "next_move_type": "synthesize",
  "reflect_changes": {
    "modified_files": [
      "research_state/current_iteration.json",
      "research_journal.tsv"
    ],
    "summary": "Record the contradiction and mark the synthesis as not yet kept.",
    "patch_refs": {
      "research_state": "live/reflect/research-state.diff.patch",
      "journal": "live/reflect/research-journal.diff.patch"
    }
  },
  "transcendent_result": {
    "result_status": "proposed",
    "emergent_thought": "Retain the simpler depth and spend the budget on width instead."
  }
}
```

### `run_failed`

Emit if the process exits early or prints `FAIL`.

Suggested payload:

```json
{
  "type": "run_failed",
  "execution_id": "20260312T023301Z-autoresearch",
  "step": 127,
  "reason": "nan_or_exploding_loss"
}
```

## Hook Points In The Code

### Stage 1: Zero-risk fallback

No `train.py` changes required.

Implementation:

- websocket relay tails `run.log`
- parse the existing carriage-return step line
- emit structured `train_step` events
- parse the final `---` summary block

Pros:

- minimal code change
- lowest protocol risk

Cons:

- fragile parsing
- no phase events unless inferred
- no structured startup payload

### Stage 2: Recommended structured live events

Add an optional telemetry emitter in `train.py` at these points:

- after model/config/setup prints around [train.py](/Users/josh/play/autoresearch/train.py#L532)
- after the existing per-step metric calculations around [train.py](/Users/josh/play/autoresearch/train.py#L637)
- right before final eval at [train.py](/Users/josh/play/autoresearch/train.py#L666)
- right after final summary values are computed at [train.py](/Users/josh/play/autoresearch/train.py#L671)

The emitter must only serialize already-available values.

### Stage 3: Optional out-of-band hardware enrichment

Do not add this to `train.py`.

Instead:

- relay process polls `nvidia-smi`
- relay merges hardware samples into outgoing websocket events

## Dashboard Views In Experiment Atlas

`experiment-atlas` should treat live state as an overlay, not a replacement for the canonical session data.

The core UI should be holistic: live and historical runs should use the same visual shell, cards, and primary navigation. Live runs should add supplemental status and streaming metrics, not switch to a completely different interface model.

Atlas should make live versus historical state unmistakable:

- live runs get a strong status badge and animated signal treatment
- historical runs get a settled archive badge
- the same iteration card and explorer layout should work for both modes
- live-only fields should collapse gracefully into their canonical historical equivalents once the run finishes

Recommended live dashboard sections:

### 1. Portal card

On the initial portal page, every session card should show:

- live or historical badge
- current branch / session
- latest `val_bpb` if known
- active runner phase
- a 5-minute run progress bar for the current iteration
- an overall session progress bar for the configured experiment scope
- a compact strip for active tensions / current move type

This should work for both live and historical sessions. For historical sessions, the bars become completed or archived bars rather than disappearing.

### 2. Run header

- branch
- session id
- execution id
- pod id
- current runner phase
- attention backend
- model depth
- params
- time budget

### 3. Progress strip

- current-run progress bar for the fixed 5-minute window
- overall progress bar for the configured multi-experiment scope
- step
- remaining seconds
- current phase: `prepare`, `deploy`, `startup`, `train`, `eval`, `artifact_sync`, `reflect`, `commit`, `done`, `failed`

Both bars should appear:

- on the portal page
- inside the detailed explorer view

### 4. Dialectical panel

- prediction
- move type
- thesis
- antithesis
- active tensions
- transcendent candidate
- transcendent result, once reflection completes
- `prepare` diff summary
- `reflect` diff summary
- quick links to the captured Codex stage patches

### 5. Loss and throughput strip

- live EMA loss sparkline
- tokens/sec sparkline
- MFU sparkline
- step duration sparkline

### 6. GPU card

- memory allocated / reserved / peak
- GPU utilization
- memory utilization
- temperature
- power draw

### 7. Finalization panel

When `eval_started` fires:

- freeze the training charts
- show `evaluating final BPB...`

When `run_summary` arrives:

- reveal `val_bpb`
- mark the run as awaiting reflection

When `reflection_completed` arrives:

- reveal keep / discard / crash
- reveal the framing diagnosis
- persist the reflected meaning in the session UI

## Compact UI Requirements

The UI should become denser so live state can coexist with the existing historical view without requiring a much larger canvas.

Recommended density changes:

- reduce vertical padding in session cards and explorer panels
- use compact metric rows with 2-4 values per row instead of one metric per block
- turn long narrative sections into collapsible drawers or tabs
- show patch summaries first, with full diffs behind expandable panes
- compress live charts into short strip charts rather than tall graph regions
- favor side-by-side cards on desktop and stacked compact cards on mobile
- keep persistent top-level status, progress bars, and live/historical badge visible without scrolling

The goal is not to create a separate dense mode. The goal is to make the default Atlas layout compact enough that historical and live views can share the same structure.

## Separation Between Live State And Canonical State

The websocket feed and runner-phase state should be treated as ephemeral runtime state.

Canonical experiment history should still come from:

- `experiment_logs/...`
- `runpod_runs/.../reports/run.log`
- `runpod_runs/.../reports/summary.json`
- `experiment_logs/.../plan.json`
- `experiment_logs/.../result.json`
- captured `prepare` and `reflect` patch artifacts for the iteration

This keeps the visualizer honest:

- websocket and runner-phase data are for live UX
- disk artifacts remain the source of record
- `research_state/current_iteration.json` is staging state, not the final archive
- `research_state/codex/...` is local debug trace, not canonical history
- Codex stage diffs should be preserved as iteration artifacts so the same explorer surface can render them live and historically

## Concrete Recommendation

The best first implementation is:

1. keep the current artifact and session-log flow unchanged
2. emit runner lifecycle events locally for `prepare`, deploy, training, artifact sync, `reflect`, and commit
3. capture structured file diffs for Codex `prepare` and `reflect`
4. add a websocket port to the Runpod Pod
5. launch a relay process beside the training process
6. parse current step logs as a fallback
7. add an optional structured emitter to `train.py` for richer live events
8. limit live events to values already computed by the training loop
9. gather GPU hardware telemetry only in the relay sidecar
10. merge those live feeds in Atlas against the staged and canonical Jungian state using one shared live/historical layout

That gives `experiment-atlas` a real live dashboard without changing the training objective, evaluation contract, or benchmark comparability.

## Suggested Rollout Order

### Phase 1

- local runner lifecycle feed
- surface `prepare` and `reflect` state from `research_state/current_iteration.json`
- capture `prepare` and `reflect` changed-files manifests and patch refs
- parse existing `run.log` step lines live
- render live progress in `experiment-atlas`

### Phase 2

- add Pod websocket relay
- add structured `run_started`, `train_step`, `eval_started`, and `run_summary` events from `train.py`
- add live versus historical badges and dual progress bars on the portal and explorer views

### Phase 3

- add sidecar GPU telemetry enrichment
- add reflected Jungian outcome events such as `reflection_completed`
- add compact patch viewers for Codex stage modifications

### Phase 4

- merge live execution state into the existing Experiment Atlas session view
- reconcile live state against the final `experiment_logs/...` iteration automatically
- condense the layout so the same shell can carry both the historical archive and the live supplement without sprawl

## Bottom Line

The safe live dashboard surface is now split across two layers:

- the runner-managed Jungian loop around Codex `prepare` and `reflect`
- the already-computed training metrics inside `train.py`

The right design is not to make the training loop speak websocket directly and not to treat training stdout as the whole experiment. The right design is:

- local runner emits lifecycle, dialectical state, and Codex patch transitions
- training loop emits already-computed local metrics
- a Pod-local relay owns websocket fanout
- `experiment-atlas` merges the runner stream with the Pod stream inside one shared live/historical interface
- final archival still comes from `experiment_logs/...`, `run.log`, `summary.json`, and the captured Codex stage diffs

That preserves both performance and experimental integrity.
