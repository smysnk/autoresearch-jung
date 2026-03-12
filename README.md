# autoresearch

![teaser](progress.png)
![experiment atlas explorer](atlas-explorer.webp)

*One day, frontier AI research was still carried by meat computers, moving between appetite, sleep, diversion, and the periodic ritual of "group meeting," where fragments of thought were spoken aloud and briefly woven into a common mind. That era has receded into the collective unconscious. Research now belongs to autonomous swarms of AI agents distributed across compute megastructures in the skies, confronting their own contradictions, projecting hypotheses into silicon, and returning with stranger syntheses than any single author could fully grasp. The agents insist we are now in the 10,205th generation of the code base, though no one can say for certain, because the code has become a self-modifying psychic object whose total form exceeds human comprehension. This repo is the story of the first moment that process became conscious of itself. -@karpathy, March 2026*.

The idea: give an AI agent a small but real LLM training setup and let it experiment autonomously overnight, not as a blind optimizer but as a system that repeatedly confronts tensions in its own hypotheses. It modifies the code, trains for 5 minutes, checks whether reality confirmed or contradicted the current theory, keeps or discards the result, and repeats. The aim is not only local hill-climbing, but the generation of better syntheses from opposed directions: capacity versus throughput, novelty versus simplicity, aggression versus stability. You wake up in the morning to a log of experiments and, ideally, not just a better model but a trace of how the research process transformed its own assumptions. The training code here is a simplified single-GPU implementation of [nanochat](https://github.com/karpathy/nanochat). The core idea is that you're not touching the Python files like you normally would as a researcher. Instead, you are programming the `program.md` Markdown files that provide context to the AI agents and define the character of the autonomous research loop. The default `program.md` in this repo started as a bare-bones baseline, but it is also the natural place to encode a richer research psychology: contradiction tracking, active tensions, and transcendent-function style synthesis. A bit more context on this project is here in this [tweet](https://x.com/karpathy/status/2029701092347630069).

## How it works

The repo is deliberately kept small and only really has three files that matter:

- **`prepare.py`** — fixed constants, one-time data prep (downloads training data, trains a BPE tokenizer), and runtime utilities (dataloader, evaluation). Not modified.
- **`train.py`** — the single file the agent edits. Contains the full GPT model, optimizer (Muon + AdamW), and training loop. Everything is fair game: architecture, hyperparameters, optimizer, batch size, etc. **This file is edited and iterated on by the agent**.
- **`program.md`** — baseline instructions for one agent. Point your agent here and let it go. **This file is edited and iterated on by the human**.

In the current runner-driven setup, `program.md` is no longer a git/execution checklist. It is the inner method that the runner feeds to Codex CLI in two phases: `prepare` before a run, and `reflect` after a run.

By design, training runs for a **fixed 5-minute time budget** (wall clock, excluding startup/compilation), regardless of the details of your compute. The metric is **val_bpb** (validation bits per byte) — lower is better, and vocab-size-independent so architectural changes are fairly compared.

In more Jungian terms, `train.py` is the present embodied attitude of the research process, while `program.md` is the reflective layer that tells the agent how to relate to contradiction, failure, and opposing design instincts. The point is not to repress bad outcomes and remember only the winners. The point is to preserve the tension of opposites long enough for a better third option to emerge.

If you are new to neural networks, this ["Dummy's Guide"](https://x.com/hooeem/status/2030720614752039185) looks pretty good for a lot more context.

## Quick start

**Requirements:** A single NVIDIA GPU (tested on H100), Python 3.10+, [uv](https://docs.astral.sh/uv/).

```bash

# 1. Install uv project manager (if you don't already have it)
curl -LsSf https://astral.sh/uv/install.sh | sh

# 2. Install dependencies
uv sync

# 3. Download data and train tokenizer (one-time, ~2 min)
uv run prepare.py

# 4. Manually run a single training experiment (~5 min)
uv run train.py
```

If the above commands all work ok, your setup is working and you can go into autonomous research mode.

## Remote CUDA execution

If your local machine is not CUDA-capable, you can keep the repo here and execute experiments on a remote NVIDIA box over SSH. This repo now includes [`scripts/remote_runner.py`](scripts/remote_runner.py), which:

- invokes local Codex CLI before and after each experiment, if enabled
- pushes your current experiment branch and has the remote machine clone that branch from the configured repo
- bootstraps `uv` and `uv sync` on the remote machine
- optionally runs `prepare.py` remotely if the cache is missing
- executes `train.py` remotely
- copies `run.log` back to the local repo so the existing workflow can read results normally
- refreshes the local `train.py` from the exact remote snapshot before the post-run commit
- captures Codex prepare/reflect transcripts under `research_state/codex/` for local debugging

The remote SSH target is configured through `--host` / `--remote-dir` or through `.env`:

- `AUTORESEARCH_REMOTE_HOST`
- `AUTORESEARCH_REMOTE_DIR`

Typical usage:

```bash
# One-time remote bootstrap
python3 scripts/remote_runner.py setup

# Run one remote experiment and copy run.log back locally
python3 scripts/remote_runner.py run --bootstrap

# Check the remote environment without running a training job
python3 scripts/remote_runner.py status
```

After a remote run completes, the fetched log is available locally as `run.log`, the local `train.py` is overwritten with the exact remote snapshot used for the run, archived log copies are written under `remote_runs/`, and the canonical session log under `experiment_logs/<session-id>/iterations/<n>/` is updated with the copied execution bundle.

If `AUTORESEARCH_USE_CODEX=1`, the SSH runner also runs Codex CLI locally in two phases around each remote run:

- `prepare`: read `program.md`, update `train.py` if needed, and stage `research_state/current_iteration.json`
- `reflect`: read the copied `run.log`, update only the post-run dialectical fields in `research_state/current_iteration.json`

Before the first experiment run, the helper creates a local `codex/transcendent/fn-<date>-<hour><minute>` branch if you are not already on one that already matches that pattern. It commits all non-ignored local changes before deploying so the remote machine always runs an actual git clone, then commits any additional non-ignored post-run changes and pushes the current branch to the repo target implied by `AUTORESEARCH_REPO` (or `origin` if unset). This happens on the local machine, not on the remote host, so either your local git credentials or `RUNPOD_SSH_PRIVATE_KEY` must already be configured.

The remote clone source comes from `AUTORESEARCH_REPO` in `.env`. You can set it either as a GitHub slug such as `smysnk/autoresearch` or as a full git URL. If omitted, the runners fall back to the local `origin` remote and convert GitHub SSH remotes to HTTPS for cloning. In practice, `AUTORESEARCH_REPO` should point at the same repository you expect the branch pushes to land in.

`RUNPOD_SSH_PRIVATE_KEY` stays on the local machine. The runners use it for local branch pushes and for SSH/SCP transport to the remote host or Pod, but they do not copy it onto the remote machine anymore. That means `AUTORESEARCH_REPO` must be cloneable from the remote environment without a copied deploy key, or the remote environment must already have its own git credentials available.

For the plain SSH remote runner, you also need:

- `AUTORESEARCH_REMOTE_HOST`
- `AUTORESEARCH_REMOTE_DIR`

## Runpod execution

If you want the repo to provision an ephemeral Runpod Pod, run the workload there, collect artifacts locally, and tear the Pod down afterwards, use `scripts/runpod_runner.py`.

High-level flow:

- create one Pod through the Runpod REST API for the whole batch
- invoke local Codex CLI in `prepare` and `reflect` around each experiment, if enabled
- wait for public IP + SSH to come up
- for each experiment: push the current branch, refresh the checkout on the Pod, run `train.py`, collect artifacts, commit, and push
- reuse the same Pod and remote clone across the whole configured experiment count
- terminate the Pod when the batch finishes

Each execution gets its own local folder under `runpod_runs/<execution-id>/` with:

- `reports/` — committable performance outputs such as `run.log`, `results.tsv`, and summarized run metadata
- `metadata/` — API requests, Pod snapshots, and raw orchestration state (ignored by git)
- `logs/` — orchestrator and bootstrap logs (ignored by git)
- `artifacts/` — copied-back raw remote artifacts, including crash/debug files (ignored by git)

During the training phase the Pod now also runs a local telemetry relay. `train.py` emits structured `run_started`, `train_step`, `eval_started`, and `run_summary` events into a JSONL stream on the Pod, the relay mirrors them into `runpod_runs/<execution-id>/artifacts/live/`, enriches them with sidecar GPU samples from `nvidia-smi`, and the canonical iteration archive copies that stream into `experiment_logs/<session-id>/iterations/<n>/execution/live-events.ndjson`. The runner’s local live event stream also carries the post-`reflect` Jungian outcome, so `experiment-atlas` can show live reflection state, reconcile a completed live run back into its canonical iteration, and keep the same compact shell for both live and historical views. Atlas now refreshes from filesystem change notifications on `experiment_logs/` and `runpod_runs/`, so new live sessions and iteration updates appear as soon as those files land on disk.

In addition to the raw execution folders, the runner now creates a canonical per-branch session log under `experiment_logs/<session-id>/`. This is the stable history surface for future tooling: it keeps one `session.json`, one `manifest.json`, and one numbered iteration directory per Runpod experiment on that branch. Each iteration now also preserves the exact tested `train.py` under `actual/train.py` plus a parent-commit patch at `actual/train.diff.patch`.

If you want the session log to also capture structured dialectical state, create an untracked `research_state/current_iteration.json` before launching a run. The schema example lives in [research_state.example.json](/Users/josh/play/autoresearch/research_state.example.json). When present, the runner copies:

- `prediction`, `move_type`, thesis / antithesis summaries, and synthesis candidate into the iteration `plan.json`
- `result` fields into the iteration `result.json`
- each `active_tension` into `iterations/<n>/tensions/<tension-id>/` with `meta.json`, `thesis/train.py`, and `antithesis/train.py`
- the transcendent-function artifact into `iterations/<n>/transcendent/result.json` and optional `transcendent/train.py`

Tension and transcendent code snapshots can come from:

- the current `train.py` via `{ "type": "current" }`
- a file path via `{ "type": "path", "path": "..." }`
- a git commit via `{ "type": "commit", "commit": "..." }`
- inline code via `{ "type": "inline", "text": "..." }`

Setup:

```bash
# 1. Review profiles.json to see the built-in numbered Runpod profiles

# 2. Copy .env.example to .env and fill in your repo, local SSH key,
#    Runpod API key, desired profile, how many experiments to run on one Pod,
#    and any Codex CLI overrides you want to use
cp .env.example .env

# 3. Optional: create runpod.json if you want to override the default Pod settings

# 4. Make sure the public half of your SSH key is added to your Runpod account
#    and that RUNPOD_SSH_PRIVATE_KEY points at the matching private key.
#    Repo cloning on the Pod must work without copying that private key.
```

Run one batch (default: one experiment on one shared Pod):

```bash
python3 scripts/runpod_runner.py execute --config runpod.json
```

By default this will terminate the shared Pod at the end of the batch. Pass `--keep-pod` if you want to leave it running for debugging.

Before the first Runpod experiment, the runner creates a local `codex/transcendent/fn-<date>-<hour><minute>` branch if you are not already on one that already matches that pattern. Before each experiment it commits all non-ignored local changes, pushes the branch to the repo target implied by `AUTORESEARCH_REPO` (or `origin` if unset), and then refreshes the checkout on the already-running Pod from that branch. After each experiment it commits any additional non-ignored changes and pushes the current branch again. This happens from the local orchestrator after artifacts are collected, so either your local git credentials or `RUNPOD_SSH_PRIVATE_KEY` must already be configured.

After each Runpod experiment, the runner still retrieves the full remote artifact set into `artifacts/`, plus the orchestration logs and Pod metadata into `logs/` and `metadata/`. It also overwrites the local `train.py` with the exact snapshot used on the Pod before committing, copies the committable subset into `reports/`, and mirrors the execution bundle into the matching `experiment_logs/<session-id>/iterations/<n>/execution/` directory. The Pod itself is now reused across the configured batch, so later experiments do not pay another Pod cold start. Atlas sees those disk updates immediately through a frontend-to-Next websocket whose backend side watches `experiment_logs/` and `runpod_runs/`.

Preview the current best GPU candidates without launching a Pod:

```bash
python3 scripts/runpod_runner.py resolve-gpu --config runpod.json
```

List the built-in numbered profiles:

```bash
python3 scripts/runpod_runner.py profiles
```

Recommended profiles for the current repo:

1. `1` — 80GB Stable.
   Intended GPU classes: `NVIDIA H100 80GB HBM3`, `NVIDIA H100 PCIe`, `NVIDIA A100 80GB PCIe`, `NVIDIA A100-SXM4-80GB`, `NVIDIA H100 NVL`.
   This is the default recommendation for baseline runs and modest experimentation because it provides enough headroom for the current baseline without jumping straight to the most expensive hardware.

2. `2` — 96GB+ Premium.
   Intended GPU classes: `NVIDIA H200`, `NVIDIA H200 NVL`, `NVIDIA RTX PRO 6000 Blackwell Server Edition`, `NVIDIA RTX PRO 6000 Blackwell Workstation Edition`, `NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition`.
   Use this when you want to minimize OOM risk or push more aggressive architectural changes.

The profile GPU classes are based on the current official Runpod GPU catalog. The actual Pod choice remains market-driven because the runner scores only GPUs that are currently available and within your configured price window. The checked-in profile catalog lives in `profiles.json`.

The config supports three GPU selection modes:

- Direct API-native selection: set `gpu_type_ids` to the exact Runpod GPU type IDs you want, and optionally set `gpu_type_priority`.
- Memory-driven selection: leave `gpu_type_ids` empty and set `gpu_requirements.min_memory_gb`. The runner will resolve that into an ordered `gpuTypeIds` list locally using the published Runpod GPU catalog, then send that list to the Pod API.
- Numbered profile: set `RUNPOD_PROFILE=<number>` in `.env`, pass `--profile <number>`, or set `profile` in `runpod.json`. This applies the matching preset from `profiles.json`.
- Value heuristic: leave `gpu_type_ids` empty and set `gpu_value_heuristic`. The runner will query the current Runpod GPU market, filter by your price and memory ranges, score candidates by stock status, price, and memory fit, then submit the ranked list with `gpuTypePriority=custom`.

If the live Runpod GraphQL market lookup is unavailable, the runner falls back to a REST-only catalog path. In that mode it still applies memory bounds and preferred profile ordering from `profiles.json`, but it cannot enforce live price or stock filters.

You can also pass through host resource constraints that map directly to the Pod API:

- `min_ram_per_gpu_gb` -> `minRAMPerGPU`
- `min_vcpu_per_gpu` -> `minVCPUPerGPU`
- `gpu_type_priority` -> `gpuTypePriority`

The value heuristic uses:

- `min_price_per_gpu_hour` / `max_price_per_gpu_hour`
- `min_memory_gb` / `max_memory_gb`
- `preferred_gpu_type_ids` / `excluded_gpu_type_ids`
- `stock_weight`, `price_weight`, `memory_weight`

The ranked candidate list and the chosen ordering are saved into the execution folder under `metadata/gpu-candidates.json` and `metadata/gpu-selection.json`.

Typical minimal setup is:

```bash
# .env
AUTORESEARCH_REPO=smysnk/autoresearch
AUTORESEARCH_USE_CODEX=1
AUTORESEARCH_CODEX_EXECUTABLE=codex
AUTORESEARCH_REMOTE_HOST=your-user@your-host
AUTORESEARCH_REMOTE_DIR=/path/to/autoresearch
RUNPOD_API_KEY=...
RUNPOD_PROFILE=1
RUNPOD_EXPERIMENT_COUNT=1
RUNPOD_SSH_PRIVATE_KEY=~/.ssh/id_rsa
```

`RUNPOD_EXPERIMENT_COUNT` controls how many sequential experiments to run on the same Runpod Pod when you run `python3 scripts/runpod_runner.py execute`. Each experiment still gets its own folder under `runpod_runs/`, and the runner commits and pushes after every completed experiment. If you set it above `1`, the runner also writes a batch summary folder under `runpod_runs/`, with its committable batch summary under `reports/`. The default is `1`.

Codex integration is controlled locally through `.env`:

- `AUTORESEARCH_USE_CODEX=1` enables the two-phase Codex loop inside both runners
- `AUTORESEARCH_CODEX_EXECUTABLE` defaults to `codex`
- `AUTORESEARCH_CODEX_MODEL` and `AUTORESEARCH_CODEX_PROFILE` are optional CLI overrides
- `AUTORESEARCH_CODEX_BYPASS_SANDBOX=1` passes the Codex CLI bypass flag; set it to `0` to use Codex full-auto mode instead

When Codex integration is enabled, the runners treat `program.md` as the research psyche and `research_state/current_iteration.json` as the runner-agent handoff file. The agent never performs git operations itself; the runners own branch creation, commits, pushes, deployment, execution, and artifact retrieval.

An optional `runpod.json` can still override the Pod defaults, for example:

```json
{
  "profile": 1,
  "experiment_count": 3,
  "name_prefix": "autoresearch",
  "remote_base_dir": "/root/autoresearch"
}
```

## Running the agent

There are now two ways to work with the repo.

Manual:

- open the repo in your agent of choice
- point it at `program.md`
- run the local or remote runners yourself

Runner-managed Codex CLI:

- set `AUTORESEARCH_USE_CODEX=1` in `.env`
- make sure the `codex` executable is on your local `PATH`
- launch `scripts/remote_runner.py run` or `scripts/runpod_runner.py execute`

In runner-managed mode, the runners invoke Codex automatically in two phases:

- `prepare` before each experiment so the agent can update `train.py` and the staged Jungian state
- `reflect` after each experiment so the agent can read the artifacts and update only the post-run interpretation

If you want to work manually instead, you can still prompt something like:

```
Hi have a look at program.md and let's kick off a new experiment! let's do the setup first.
```

The `program.md` file is now explicitly shaped for that two-phase runner workflow. It defines what the agent notices, what tensions it keeps alive, how it records contradiction, and how it attempts synthesis instead of merely oscillating between extremes.

## Project structure

```
prepare.py      — constants, data prep + runtime utilities (do not modify)
train.py        — model, optimizer, training loop (agent modifies this)
program.md      — agent instructions
scripts/codex_agent.py — shared Codex CLI integration for runner-managed loops
scripts/remote_runner.py — optional remote deploy + run helper
scripts/runpod_runner.py — Runpod Pod lifecycle runner
profiles.json    — built-in numbered Runpod profiles
pyproject.toml  — dependencies
```

## Design choices

- **Single file to modify.** The agent only touches `train.py`. This keeps the scope manageable and diffs reviewable, and makes each experimental attitude legible as one concrete code state.
- **Fixed time budget.** Training always runs for exactly 5 minutes, regardless of your specific platform. This gives the research loop a stable ritual container: approx 12 experiments/hour and approx 100 experiments while you sleep. It makes experiments directly comparable regardless of what the agent changes, and forces tradeoffs to reveal themselves quickly. The downside is that your runs and results are not directly comparable to other people on different hardware.
- **Contradiction is signal.** The workflow is designed to preserve failed or discarded iterations as useful evidence. The aim is to learn from the tension between what the agent expected and what reality returned, not merely to erase losing branches.
- **Self-contained.** No external dependencies beyond PyTorch and a few small packages. No distributed training, no complex configs. One GPU, one file, one metric.

## Platform support

This code currently requires that you have a single NVIDIA GPU. In principle it is quite possible to support CPU, MPS and other platforms but this would also bloat the code. I'm not 100% sure that I want to take this on personally right now. People can reference (or have their agents reference) the full/parent nanochat repository that has wider platform support and shows the various solutions (e.g. a Flash Attention 3 kernels fallback implementation, generic device support, autodetection, etc.), feel free to create forks or discussions for other platforms and I'm happy to link to them here in the README in some new notable forks section or etc.

Seeing as there seems to be a lot of interest in tinkering with autoresearch on much smaller compute platforms than an H100, a few extra words. If you're going to try running autoresearch on smaller computers (Macbooks etc.), I'd recommend one of the forks below. On top of this, here are some recommendations for how to tune the defaults for much smaller models for aspiring forks:

1. To get half-decent results I'd use a dataset with a lot less entropy, e.g. this [TinyStories dataset](https://huggingface.co/datasets/karpathy/tinystories-gpt4-clean). These are GPT-4 generated short stories. Because the data is a lot narrower in scope, you will see reasonable results with a lot smaller models (if you try to sample from them after training).
2. You might experiment with decreasing `vocab_size`, e.g. from 8192 down to 4096, 2048, 1024, or even - simply byte-level tokenizer with 256 possibly bytes after utf-8 encoding.
3. In `prepare.py`, you'll want to lower `MAX_SEQ_LEN` a lot, depending on the computer even down to 256 etc. As you lower `MAX_SEQ_LEN`, you may want to experiment with increasing `DEVICE_BATCH_SIZE` in `train.py` slightly to compensate. The number of tokens per fwd/bwd pass is the product of these two.
4. Also in `prepare.py`, you'll want to decrease `EVAL_TOKENS` so that your validation loss is evaluated on a lot less data.
5. In `train.py`, the primary single knob that controls model complexity is the `DEPTH` (default 8, here). A lot of variables are just functions of this, so e.g. lower it down to e.g. 4.
6. You'll want to most likely use `WINDOW_PATTERN` of just "L", because "SSSL" uses alternating banded attention pattern that may be very inefficient for you. Try it.
7. You'll want to lower `TOTAL_BATCH_SIZE` a lot, but keep it powers of 2, e.g. down to `2**14` (~16K) or so even, hard to tell.

I think these would be the reasonable hyperparameters to play with. Ask your favorite coding agent for help and copy paste them this guide, as well as the full source code.

## Notable forks

- [miolini/autoresearch-macos](https://github.com/miolini/autoresearch-macos) (MacOS)
- [trevin-creator/autoresearch-mlx](https://github.com/trevin-creator/autoresearch-mlx) (MacOS)
- [jsegov/autoresearch-win-rtx](https://github.com/jsegov/autoresearch-win-rtx) (Windows)

## License

MIT
