# autoresearch

This is an experiment to have the LLM do its own research.

## Setup

To set up a new experiment, work with the user to:

1. **Agree on a run tag**: propose a tag based on today's date and time (e.g. `mar5-1430`). The branch `codex/transcendent/fn-<tag>` must not already exist — this is a fresh run.
2. **Create the branch**: `git checkout -b codex/transcendent/fn-<tag>` from current master.
3. **Read the in-scope files**: The repo is small. Read these files for full context:
   - `README.md` — repository context.
   - `prepare.py` — fixed constants, data prep, tokenizer, dataloader, evaluation. Do not modify.
   - `train.py` — the file you modify. Model architecture, optimizer, training loop.
4. **Verify the execution target**:
   - local execution: Check that `~/.cache/autoresearch/` contains data shards and a tokenizer. If not, tell the human to run `uv run prepare.py`.
   - remote execution: Confirm the SSH target is reachable. `python3 scripts/remote_runner.py setup` will prepare the remote cache if it is missing.
5. **Initialize results.tsv**: Create `results.tsv` with just the header row. The baseline will be recorded after the first run.
6. **Initialize research_journal.tsv**: Create `research_journal.tsv` with just the header row. This is an untracked scratchpad for predictions, contradictions, and synthesis notes.
7. **Initialize structured iteration state**: Keep an untracked `research_state/current_iteration.json` for the current candidate run. Use `research_state.example.json` as the schema reference. This is the staging file for prediction, active tensions, thesis/antithesis sources, transcendent-function state, and post-run interpretation.
8. **Optional remote bootstrap**: If the experiments should run on a remote CUDA machine, run `python3 scripts/remote_runner.py setup`. This pushes the current experiment branch and has the remote host clone it from the configured repo, bootstraps `uv`, prepares data if needed, and keeps the execution environment there. The fetched `run.log` will still appear locally after each run, the exact remote `train.py` snapshot will be copied back over the local `train.py` before the post-run commit, and the structured session log under `experiment_logs/<session-id>/` will be updated from `research_state/current_iteration.json`.
9. **Confirm and go**: Confirm setup looks good.

Once you get confirmation, kick off the experimentation.

## Experimentation

Each experiment runs on a single GPU. The training script runs for a **fixed time budget of 5 minutes** (wall clock training time, excluding startup/compilation). You launch it simply as: `uv run train.py`.

If you are using the remote runner, launch experiments with `python3 scripts/remote_runner.py run --bootstrap` instead. It pushes your local experiment branch, has the remote machine clone that branch from the configured repo, executes `train.py` there, copies `run.log` back to the local repo, refreshes the local `train.py` from the exact remote snapshot used for the run, and materializes the staged dialectical state into `experiment_logs/<session-id>/iterations/<n>/`.

**What you CAN do:**
- Modify `train.py` — this is the only model/training code file you edit. Everything is fair game: model architecture, optimizer, hyperparameters, training loop, batch size, model size, etc.
- Update structured logging inputs under `research_state/` for the current iteration. These are operational metadata, not additional training code.

**What you CANNOT do:**
- Modify `prepare.py`. It is read-only. It contains the fixed evaluation, data loading, tokenizer, and training constants (time budget, sequence length, etc).
- Install new packages or add dependencies. You can only use what's already in `pyproject.toml`.
- Modify the evaluation harness. The `evaluate_bpb` function in `prepare.py` is the ground truth metric.

**The goal is simple: get the lowest val_bpb.** Since the time budget is fixed, you don't need to worry about training time — it's always 5 minutes. Everything is fair game: change the architecture, the optimizer, the hyperparameters, the batch size, the model size. The only constraint is that the code runs without crashing and finishes within the time budget.

**VRAM** is a soft constraint. Some increase is acceptable for meaningful val_bpb gains, but it should not blow up dramatically.

**Simplicity criterion**: All else being equal, simpler is better. A small improvement that adds ugly complexity is not worth it. Conversely, removing something and getting equal or better results is a great outcome — that's a simplification win. When evaluating whether to keep a change, weigh the complexity cost against the improvement magnitude. A 0.001 val_bpb improvement that adds 20 lines of hacky code? Probably not worth it. A 0.001 val_bpb improvement from deleting code? Definitely keep. An improvement of ~0 but much simpler code? Keep.

**The first run**: Your very first run should always be to establish the baseline, so you will run the training script as is.

## Research method: productive contradiction

Do not merely hill-climb. Maintain explicit working theories about why `val_bpb` improves or worsens.

Before every edit to `train.py`, write a one-sentence prediction for yourself in this form:

```text
Prediction: Changing <X> will improve/worsen <Y> because <mechanism>.
```

After every run, record four things for yourself before deciding the next move:

1. what you expected to happen
2. what actually happened
3. what assumption was contradicted
4. what tradeoff or tension the result revealed

Treat contradiction as useful signal, not just failure. If an experiment underperforms, do not only revert and forget it. First identify the source of dissonance.

Useful contradiction categories:

- capacity vs throughput
- novelty vs simplicity
- memory use vs quality
- optimization speed vs stability
- short-run gain vs long-run extensibility

Also distinguish failure of the idea from failure of the framing. A weak result can mean:

- the idea was bad
- the comparison was unfair
- the change set was confounded
- the variant was mis-scaled for the 5-minute budget

Before abandoning a direction, decide which of those happened.

## Active tensions

Keep 2-4 active oppositions in mind at any given time. Examples:

- deeper model vs higher token throughput
- architectural novelty vs implementation simplicity
- aggressive optimization vs training stability
- inductive bias vs parameter efficiency

Each experiment should explicitly do one of three things relative to an active tension:

- `exploit`: strengthen a working idea
- `negate`: directly challenge the current favored theory
- `synthesize`: combine two competing ideas into a third option

Avoid repeating the same local search move unless the new run tests a meaningfully different mechanism.

## Transcendent-function mode

When two opposing directions both show evidence, do not force a premature binary choice. Try to synthesize them into a third option that preserves the strengths of both.

Examples:

- If larger depth helps quality but hurts throughput, simplify elsewhere and reallocate saved compute.
- If a simpler model matches a more complex one, prefer the simpler one.
- If an aggressive optimizer improves speed but harms stability, search for a constrained version instead of fully adopting or rejecting it.

At least every 3 experiments, pause and do:

1. name the strongest current thesis
2. name the strongest current antithesis
3. propose one concrete synthesis experiment

The synthesis must be testable in `train.py` within one run.

## Experiment proposal discipline

Before editing `train.py`, decide and record:

- the active tension this experiment is probing
- the move type: `exploit`, `negate`, or `synthesize`
- the one-sentence prediction

After the run, record:

```text
Outcome: confirmed / contradicted / mixed
Interpretation: <updated theory>
Next move: exploit / negate / synthesize
```

Your post-run note should be short and concrete. Its purpose is to sharpen the next experiment, not to produce an essay.

## Structured experiment log

The canonical history for a research session lives under:

```text
experiment_logs/<session-id>/
```

Where `<session-id>` is the current branch slug, e.g. `codex-transcendent-fn-mar5-1430`.

Before every run, update `research_state/current_iteration.json` so it contains the current:

- prediction
- move type
- why this run is happening now
- thesis / antithesis summaries
- active tensions
- transcendent-function candidate

Each active tension must be represented as a pair of code states, not only prose:

- thesis `train.py`
- antithesis `train.py`

Use the source forms shown in `research_state.example.json` (`current`, `path`, `commit`, or `inline`) so the runner can materialize those poles into the structured session log.

After every run, update the `result` section in `research_state/current_iteration.json` with:

- outcome
- contradicted assumption
- keep/discard/crash status
- framing diagnosis
- next move type
- short summary text

Also record the transcendent-function result as a first-class object. If a synthesis emerged, say what thesis and antithesis it came from, what the emergent thought was, what concrete `train.py` change it implied, and whether that synthesis was kept or discarded.

Do not reset, discard, or advance the branch until this structured post-run state has been updated. The point is to preserve every iteration even when the branch later rewinds.

## Output format

Once the script finishes it prints a summary like this:

```
---
val_bpb:          0.997900
training_seconds: 300.1
total_seconds:    325.9
peak_vram_mb:     45060.2
mfu_percent:      39.80
total_tokens_M:   499.6
num_steps:        953
num_params_M:     50.3
depth:            8
```

Note that the script is configured to always stop after 5 minutes, so depending on the computing platform of this computer the numbers might look different. You can extract the key metric from the log file:

```
grep "^val_bpb:" run.log
```

## Logging results

When an experiment is done, log it to `results.tsv` (tab-separated, NOT comma-separated — commas break in descriptions).

The TSV has a header row and 5 columns:

```
commit	val_bpb	memory_gb	status	description
```

1. git commit hash (short, 7 chars)
2. val_bpb achieved (e.g. 1.234567) — use 0.000000 for crashes
3. peak memory in GB, round to .1f (e.g. 12.3 — divide peak_vram_mb by 1024) — use 0.0 for crashes
4. status: `keep`, `discard`, or `crash`
5. short text description of what this experiment tried

Example:

```
commit	val_bpb	memory_gb	status	description
a1b2c3d	0.997900	44.0	keep	baseline
b2c3d4e	0.993200	44.2	keep	increase LR to 0.04
c3d4e5f	1.005000	44.0	discard	switch to GeLU activation
d4e5f6g	0.000000	0.0	crash	double model width (OOM)
```

Also keep an untracked `research_journal.tsv` scratchpad for quick dialectical notes. Use this header:

```
experiment	parent_commit	prediction	outcome	contradicted_assumption	tension	move_type	synthesis_note
```

Keep `results.tsv` compact and canonical for the summary table. Use `research_journal.tsv` only as a lightweight scratchpad. The machine-readable source of truth for a future visualizer is the structured session log under `experiment_logs/<session-id>/`. Do not commit `results.tsv` or `research_journal.tsv`.

## The experiment loop

The experiment runs on a dedicated branch (e.g. `codex/transcendent/fn-mar5-1430` or `codex/transcendent/fn-mar5-1430-gpu0`).

LOOP FOREVER:

1. Look at the git state: the current branch/commit we're on
2. Maintain 2-4 active tensions. Every 3 experiments, explicitly write down the current thesis, antithesis, and one synthesis candidate before choosing the next change.
3. Choose a move type: `exploit`, `negate`, or `synthesize`.
4. Update `research_state/current_iteration.json` with the prediction, move type, thesis, antithesis, synthesis candidate, and result placeholder for this iteration.
5. If an active tension needs explicit code poles, update the referenced thesis / antithesis `train.py` snapshots under `research_state/` before you run.
6. Optionally mirror the prediction and tension in `research_journal.tsv` for quick scanning.
7. Tune `train.py` with an experimental idea by directly hacking the code.
8. git commit
9. Run the experiment:
   - local CUDA: `uv run train.py > run.log 2>&1`
   - remote CUDA: `python3 scripts/remote_runner.py run --bootstrap`
   In both cases, make sure the current run leaves a local `run.log` behind. Do NOT use tee or let output flood your context.
10. Read out the results: `grep "^val_bpb:\|^peak_vram_mb:" run.log`
11. If the grep output is empty, the run crashed. Run `tail -n 50 run.log` to read the Python stack trace and attempt a fix. If you can't get things to work after more than a few attempts, give up.
12. Before any keep/discard decision, update the `result` and `transcendent` sections in `research_state/current_iteration.json` so the structured log preserves what happened in this iteration.
13. Record the outcome in `research_journal.tsv`: confirmed / contradicted / mixed, the contradicted assumption if any, the active tension, and the next move type.
14. Record the results in `results.tsv` (NOTE: do not commit `results.tsv` or `research_journal.tsv`; leave both untracked by git)
15. If `val_bpb` improved (lower), you "advance" the branch, keeping the git commit
16. If `val_bpb` is equal or worse, usually git reset back to where you started, but only after the structured log has been updated and you have decided whether the failure was in the idea or in the framing
17. If a flat or worse run reveals a useful contradiction, use it immediately to drive a negation or synthesis experiment instead of forgetting it

The idea is that you are a completely autonomous researcher trying things out. If they work, keep. If they don't, discard. And you're advancing the branch so that you can iterate. If you feel like you're getting stuck in some way, you can rewind but you should probably do this very very sparingly (if ever).

**Timeout**: Each experiment should take ~5 minutes total (+ a few seconds for startup and eval overhead). If a run exceeds 10 minutes, kill it and treat it as a failure (discard and revert).

**Crashes**: If a run crashes (OOM, or a bug, or etc.), use your judgment: If it's something dumb and easy to fix (e.g. a typo, a missing import), fix it and re-run. If the idea itself is fundamentally broken, just skip it, log "crash" as the status in the tsv, and move on.

**NEVER STOP**: Once the experiment loop has begun (after the initial setup), do NOT pause to ask the human if you should continue. Do NOT ask "should I keep going?" or "is this a good stopping point?". The human might be asleep, or gone from a computer and expects you to continue working *indefinitely* until you are manually stopped. You are autonomous. If you run out of ideas, think harder — read papers referenced in the code, re-read the in-scope files for new angles, try combining previous near-misses, try more radical architectural changes. The loop runs until the human interrupts you, period.

As an example use case, a user might leave you running while they sleep. If each experiment takes you ~5 minutes then you can run approx 12/hour, for a total of about 100 over the duration of the average human sleep. The user then wakes up to experimental results, all completed by you while they slept!
