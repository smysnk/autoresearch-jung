# Experiment Log Visualizer Plan

## Goal

Add a durable experiment log that captures every iteration of `train.py` changes, the active tensions at that point in time, and the transcendent-function result, so a future visualizer can load one session and inspect the full research history.

The key requirement is not just metric capture. The system must preserve:

- the exact `train.py` version that was tested
- the active tensions at that moment
- the thesis and antithesis code states for each tension
- the emergent synthesis / transcendent-function result
- the final run metrics and keep/discard outcome

This must work even when the research loop rewinds or discards a commit.

## Current State

The repo currently has two logging layers:

- raw execution capture under `runpod_runs/<execution-id>/` and `remote_runs/`
- lightweight dialectical notes in the untracked `research_journal.tsv`

That is not enough for a visualizer because:

- `research_journal.tsv` is not canonical or structured enough
- discarded iterations are not preserved as full code snapshots
- active tensions are described in text only, not as code states
- transcendent-function output is not recorded as a first-class object
- execution folders are run-centric, not session-centric

## Design Principles

- Keep raw transport logs (`runpod_runs`, `remote_runs`) for debugging.
- Add a separate session log optimized for history browsing.
- Prefer full `train.py` snapshots over diffs as the primary representation.
- Capture state before any reset or discard can erase it.
- Keep `results.tsv` as the compact summary table.
- Make the new log the canonical source for any future visualizer.

## Proposed Architecture

Add a new tracked directory:

```text
experiment_logs/<session-id>/
```

Where:

- `<session-id>` is the experiment branch slug, e.g. `codex-autoresearch-mar11-2313`
- this directory represents the full history of one research session
- each iteration gets a dedicated subdirectory with both pre-run and post-run state

This becomes the visualizer input surface.

Keep existing execution folders:

- `runpod_runs/<execution-id>/` remains execution-centric
- `remote_runs/` remains SSH-run archival output

These continue to exist, but they are not the primary browsing model.

## Canonical On-Disk Layout

```text
experiment_logs/<session-id>/
  manifest.json
  session.json
  iterations/
    001/
      plan.json
      result.json
      actual/
        train.py
        train.diff.patch
      tensions/
        depth-vs-throughput/
          meta.json
          thesis/
            train.py
          antithesis/
            train.py
      transcendent/
        result.json
        train.py
      execution/
        run.log
        summary.json
        run-metadata.json
        execution-ref.json
```

## Data Model

### `session.json`

Session-level metadata:

- `schema_version`
- `session_id`
- `branch`
- `created_at`
- `runner_mode` (`local`, `remote`, `runpod`)
- `objective` (`val_bpb`)
- `notes`

### `manifest.json`

Fast index for the visualizer:

- `session_id`
- `branch`
- ordered list of iteration ids
- current best iteration
- current kept commit
- latest iteration

This file should be cheap to read and enough to render a session sidebar.

### `iterations/<n>/plan.json`

Pre-run state:

- `iteration`
- `parent_commit`
- `candidate_commit`
- `created_at`
- `prediction`
- `move_type` (`exploit`, `negate`, `synthesize`)
- `active_tension_ids`
- `thesis`
- `antithesis`
- `synthesis_candidate`
- `why_now`

This file is written before the experiment is launched.

### `iterations/<n>/result.json`

Post-run state:

- `iteration`
- `completed_at`
- `outcome` (`confirmed`, `contradicted`, `mixed`, `crash`)
- `contradicted_assumption`
- `keep_discard_status`
- `framing_diagnosis`
- `next_move_type`
- `metrics`
- `summary_text`

This file is written after artifacts are collected and before any reset/discard.

### `iterations/<n>/actual/train.py`

The exact tested code snapshot.

This is the primary code object the visualizer should render for the iteration.

### `iterations/<n>/actual/train.diff.patch`

Optional convenience artifact:

- diff from `parent_commit` to the tested `train.py`

Useful for compact inspection, but not the canonical code source.

### `iterations/<n>/tensions/<id>/meta.json`

One file per active tension:

- `id`
- `label`
- `kind` (`capacity-vs-throughput`, `novelty-vs-simplicity`, etc.)
- `why_active`
- `favored_side`
- `created_in_iteration`
- `updated_in_iteration`

### `iterations/<n>/tensions/<id>/thesis/train.py`

The `train.py` snapshot representing the thesis pole.

### `iterations/<n>/tensions/<id>/antithesis/train.py`

The `train.py` snapshot representing the antithesis pole.

This is the key requirement for the visualizer: each active tension is not just text, but a pair of concrete code states.

### `iterations/<n>/transcendent/result.json`

The synthesized result:

- `source_tension_ids`
- `thesis_ref`
- `antithesis_ref`
- `emergent_thought`
- `concrete_change`
- `tested_in_iteration`
- `result_status` (`proposed`, `tested`, `kept`, `discarded`)

If the synthesis produced a concrete code candidate, also store:

- `iterations/<n>/transcendent/train.py`

## How Active Tensions Should Work

Each active tension becomes a tracked object with two poles:

- thesis
- antithesis

Each pole points to a concrete `train.py` state.

Operationally:

1. When a tension is introduced, the agent assigns it an id and label.
2. The agent snapshots the thesis `train.py`.
3. The agent snapshots the antithesis `train.py`.
4. The current iteration records whether it is exploiting one pole, negating the favored pole, or synthesizing both.

This allows the visualizer to answer:

- what code represented the favored side of this tension?
- what code represented the opposing side?
- what synthesis emerged from the tension?

## How Transcendent Function Should Be Logged

Every third experiment, or whenever the agent explicitly synthesizes opposing views, record a transcendent-function artifact with three layers:

1. **Thesis**: strongest current view
2. **Antithesis**: strongest competing view
3. **Synthesis**: emergent third option

The synthesis record must contain:

- a human-readable explanation
- the concrete `train.py` mechanism it suggests
- whether it was immediately tested
- whether it improved results

This should not live only in `research_journal.tsv`. It needs its own JSON object so a visualizer can render it directly.

## Required Prompt Changes

Update [program.md](/Users/josh/play/autoresearch/program.md) so the agent is instructed to write structured iteration state in addition to editing `train.py`.

Required changes:

1. Allow writes under a dedicated experiment-log directory.
2. Require a pre-run `plan.json` capture before launching any experiment.
3. Require active tensions to be represented as thesis/antithesis code snapshots.
4. Require a post-run `result.json` capture before any discard/reset.
5. Require the transcendent-function result to be recorded as a first-class artifact.

Important constraint:

- `train.py` remains the only model/training code file the agent edits for experiments.
- Logging artifacts are allowed as operational metadata.

## Required Runner Changes

### Shared logging module

Add a small shared Python module, for example:

```text
scripts/experiment_log.py
```

Responsibilities:

- create session directories
- allocate iteration numbers
- write `manifest.json`
- write `plan.json`
- write `result.json`
- snapshot `train.py`
- store thesis/antithesis snapshots
- store transcendent artifacts
- copy useful execution outputs into the iteration folder

This should be shared by:

- [scripts/runpod_runner.py](/Users/josh/play/autoresearch/scripts/runpod_runner.py)
- [scripts/remote_runner.py](/Users/josh/play/autoresearch/scripts/remote_runner.py)

### `runpod_runner.py`

Add hooks in this order:

1. Before `commit_nonignored_changes(...)` for the experiment candidate:
   - create / update the session log
   - write the iteration `plan.json`
   - snapshot the current `train.py`
   - snapshot active tensions and transcendent candidate
2. After artifact collection and summary parsing:
   - write `result.json`
   - copy `run.log`, `summary.json`, and `run-metadata.json` into `iterations/<n>/execution/`
   - update `manifest.json`
3. Before any post-run discard/reset logic is introduced in the future:
   - ensure the iteration log is complete

### `remote_runner.py`

Mirror the same flow:

1. pre-run plan capture
2. tested `train.py` snapshot
3. post-run result capture
4. execution artifact copy

The session log schema must be identical across local, remote, and Runpod modes.

## Git And Ignore Rules

Tracked:

- `experiment_logs/**`

Ignored:

- noisy raw transport folders that are not intended for browsing
- temporary staging state if needed, e.g. `research_state/`

Keep `runpod_runs` mostly ignored except the curated `reports/` flow if that is still useful. The new browsing story should rely on `experiment_logs`.

## Migration Strategy

Do not migrate old runs immediately.

Instead:

1. introduce the new schema
2. start populating it for all new experiments
3. optionally add a one-off backfill tool later for recent `runpod_runs/*/reports/`

The visualizer can initially target only new-format sessions.

## Visualizer Contract

The future visualizer should be able to render a session by reading only:

- `experiment_logs/<session-id>/manifest.json`
- per-iteration `plan.json`
- per-iteration `result.json`
- `actual/train.py`
- `tensions/*`
- `transcendent/result.json`

It should not need Git access and should not need to reconstruct state from diffs alone.

## Phased Implementation

### Phase 1: Schema and session directory

Implement:

- `experiment_logs/<session-id>/`
- `manifest.json`
- `session.json`
- per-iteration directories

Success criteria:

- a new session log is created automatically for a Runpod run
- iteration numbers are stable and ordered

### Phase 2: Tested code capture

Implement:

- `actual/train.py`
- `actual/train.diff.patch`

Success criteria:

- every iteration has the exact tested `train.py`
- discarded or superseded iterations still preserve their code

### Phase 3: Structured dialectical state

Implement:

- `plan.json`
- `result.json`
- tension directories with thesis / antithesis snapshots
- transcendent result capture

Success criteria:

- each iteration records active tensions as code states
- each synthesis has a structured transcendent artifact

### Phase 4: Runner integration

Implement:

- shared helper module
- Runpod integration
- SSH remote integration

Success criteria:

- both runner modes emit the same schema
- execution artifacts are copied into the matching iteration folder

### Phase 5: Prompt integration

Update:

- [program.md](/Users/josh/play/autoresearch/program.md)

Success criteria:

- the agent is instructed to keep the new structured log updated
- logging happens before resets or branch advancement decisions

### Phase 6: Visualizer bootstrap

Not part of this patch, but define the minimum consumer:

- load `manifest.json`
- render iteration list
- show tested `train.py`
- show active tensions
- show transcendent result
- show run metrics

## Risks

- The agent may not populate structured fields consistently.
  Mitigation: use JSON files with required keys, not free-form prose only.

- Tension snapshots could become too large if generalized to many files.
  Mitigation: scope the schema to `train.py` only.

- The current keep/discard workflow may erase state before logging.
  Mitigation: require pre-run and post-run capture before any reset/discard.

- Raw execution folders and canonical session logs could drift.
  Mitigation: store explicit `execution-ref.json` links from iteration records back to the raw execution directory.

## Acceptance Criteria

- Every experiment iteration has a dedicated folder under `experiment_logs/<session-id>/iterations/`.
- Every iteration preserves the exact tested `train.py`.
- Every active tension is represented as thesis and antithesis `train.py` snapshots.
- Every synthesis / transcendent-function result is stored as a structured artifact.
- A discarded experiment remains inspectable after the branch moves on.
- A future visualizer can reconstruct session state without querying Git.

## Recommended First Patch

The first implementation pass should do only this:

1. add `scripts/experiment_log.py`
2. create `experiment_logs/<session-id>/manifest.json`
3. emit one iteration folder per Runpod run
4. store `actual/train.py`, `execution/run.log`, `execution/summary.json`, and placeholder `plan.json` / `result.json`

That gives a usable substrate quickly. After that, add full tension and transcendent snapshotting in a second pass.
