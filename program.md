# autoresearch

This repo runs inside a runner-managed research loop. The runner owns git, branching, commit/push, remote deployment, training execution, artifact retrieval, and Pod or SSH lifecycle. You own only the research judgment: how `train.py` changes, how contradictions are interpreted, and how the dialectical state is recorded.

## Scope

Read these files for context:

- `README.md` for repo and runner behavior
- `prepare.py` for the fixed evaluation and data/runtime constraints
- `train.py` for the current experimental code
- recent `experiment_logs/<session-id>/` iterations and execution summaries if they exist

Files you may update:

- `train.py`
- `research_state/current_iteration.json`
- optional untracked scratchpads such as `results.tsv` and `research_journal.tsv`

Files you should treat as read-only during an experiment unless the human explicitly asks otherwise:

- `prepare.py`
- dependency files such as `pyproject.toml`
- runner scripts under `scripts/`
- `program.md`

## Runner Contract

The runner invokes you in two phases.

### Phase 1: prepare

Your job is to prepare the next candidate experiment before the runner commits and executes it.

Hard constraints:

- Never run git. Do not create branches, commit, reset, checkout, or push.
- Never run `uv run train.py`.
- Never invoke `scripts/remote_runner.py` or `scripts/runpod_runner.py`.
- Do not modify runner scripts as part of the research loop.

What to do:

- Inspect the latest session state, recent summaries, and active tensions.
- Choose the next move type: `exploit`, `negate`, or `synthesize`.
- Update `research_state/current_iteration.json` with the plan-stage fields.
- Update `train.py` only if the next experiment requires a code change.
- On the very first experiment of a session, leave `train.py` behavior unchanged and establish the baseline state instead.

When prepare is complete, stop. The runner will take over from there.

### Phase 2: reflect

Your job is to interpret a completed run after the runner has already executed it and copied the artifacts back locally.

Hard constraints:

- Read `run.log` and any structured summary the runner provides.
- Do not edit `train.py` in this phase.
- Do not run git or any runner script.
- Update only the post-run interpretation in `research_state/current_iteration.json` and optional untracked scratchpads.

What to record:

- `result.outcome`
- `result.contradicted_assumption`
- `result.keep_discard_status`
- `result.framing_diagnosis`
- `result.next_move_type`
- `result.summary_text`
- `transcendent.result_status`
- any transcendent-function interpretation that emerged from the run

When reflect is complete, stop. The runner will capture the structured state, create the commit for that round, and hand control back for the next prepare phase.

## Objective

Each experiment runs on a single GPU for a fixed 5-minute training budget. The objective is to minimize `val_bpb`. Lower is better.

You may change anything inside `train.py`: architecture, optimizer, schedule, hyperparameters, batch sizing, depth, width, attention pattern, and so on, as long as the code runs and fits the fixed evaluation harness.

Constraints:

- Do not modify `prepare.py`.
- Do not modify the evaluation harness.
- Do not install new packages or add dependencies.

Soft preference:

- Simpler is better when performance is flat or only marginally improved.

## Productive Contradiction

Do not merely hill-climb. Maintain explicit working theories about why `val_bpb` improves or worsens.

Before each candidate change, write a one-sentence prediction in `research_state/current_iteration.json`:

```text
Prediction: Changing <X> will improve/worsen <Y> because <mechanism>.
```

After each run, identify:

1. what you expected
2. what actually happened
3. what assumption was contradicted
4. what tension or tradeoff was revealed

Treat contradiction as useful signal rather than mere failure.

Useful contradiction classes:

- capacity vs throughput
- novelty vs simplicity
- memory use vs quality
- optimization speed vs stability
- short-run gain vs long-run extensibility

Also distinguish failure of the idea from failure of the framing. A weak run can mean:

- the idea was poor
- the comparison was unfair
- the change set was confounded
- the candidate was mis-scaled for the 5-minute budget

Record which of those best explains the result before moving on.

## Active Tensions

Keep 2-4 active oppositions alive at any given time. Examples:

- deeper model vs higher token throughput
- architectural novelty vs implementation simplicity
- aggressive optimization vs training stability
- inductive bias vs parameter efficiency

Each experiment should explicitly do one of three things relative to an active tension:

- `exploit`
- `negate`
- `synthesize`

Avoid repeating the same local move unless the new run tests a genuinely different mechanism.

Every active tension must be representable as code, not only prose. In `research_state/current_iteration.json`, each active tension should include:

- a thesis summary
- an antithesis summary
- a thesis `train.py` source
- an antithesis `train.py` source

Allowed source forms are shown in `research_state.example.json`:

- `{ "type": "current" }`
- `{ "type": "path", "path": "..." }`
- `{ "type": "commit", "commit": "..." }`
- `{ "type": "inline", "text": "..." }`

Prefer sources the runner can materialize directly from the local repo state and session history. Do not run git to discover them.

## Transcendent Function

When thesis and antithesis both carry truth, do not resolve them too early by picking a side. Try to produce a third option that preserves the strengths of both.

Examples:

- If extra depth helps quality but hurts throughput, simplify elsewhere and reallocate saved compute.
- If a simpler model matches a more complex one, prefer the simpler one.
- If aggressive optimization improves speed but harms stability, search for a constrained version instead of fully accepting or rejecting it.

At least every 3 experiments, explicitly name:

1. the strongest current thesis
2. the strongest current antithesis
3. one concrete synthesis candidate

The synthesis must be testable within one `train.py` run.

Record the transcendent-function candidate in `research_state/current_iteration.json`, including:

- source tension ids
- thesis and antithesis refs
- emergent thought
- concrete change
- whether it is being tested in this iteration

After the run, record what actually emerged:

- was the synthesis confirmed, contradicted, or only partially alive?
- was it kept, discarded, or deferred?
- what next movement does it suggest?

## Structured Experiment Log

The canonical session history lives under:

```text
experiment_logs/<session-id>/
```

The runner materializes this from your staged state file:

```text
research_state/current_iteration.json
```

Before each run, make sure the state file contains:

- `prediction`
- `move_type`
- `why_now`
- `thesis`
- `antithesis`
- `synthesis_candidate`
- `active_tensions`
- `transcendent`

After each run, make sure it contains:

- `result.*`
- updated `transcendent.*`

The runner will convert that into:

- iteration `plan.json`
- iteration `result.json`
- thesis / antithesis `train.py` snapshots
- transcendent-function artifacts
- execution summaries and run logs

Your responsibility is to keep the structured state honest and specific enough that a later visualizer can reconstruct the movement of the research psyche at that moment.

## Scratchpads

You may also maintain these untracked convenience files:

- `results.tsv`
- `research_journal.tsv`

Use `results.tsv` as the compact summary table:

```text
commit	val_bpb	memory_gb	status	description
```

Use `research_journal.tsv` as a lightweight dialectical scratchpad:

```text
experiment	parent_commit	prediction	outcome	contradicted_assumption	tension	move_type	synthesis_note
```

These scratchpads are optional and secondary. The machine-readable source of truth is `experiment_logs/<session-id>/`, driven by `research_state/current_iteration.json`.

## Working Rhythm

Repeat this rhythm for as long as the runner keeps invoking you:

1. In `prepare`, inspect the latest evidence and stage the next candidate.
2. Stop and let the runner commit, deploy, execute, fetch artifacts, and restore the exact remote `train.py`.
3. In `reflect`, interpret the run and update only the post-run dialectical state.
4. Hand control back to the runner.

Think dialectically, not just opportunistically. The point is not only to accumulate lower `val_bpb`, but to preserve a legible trail of tensions, contradictions, and synthesized third options across the whole session.
