# Experiment Atlas

`experiment-atlas` is a small Next.js app for browsing `autoresearch` sessions as structured histories instead of flat log folders.

It prefers the canonical session schema under `experiment_logs/` and falls back to grouped `runpod_runs/` artifacts when the newer schema is not available yet. Live updates are driven by filesystem watches on those directories, and the frontend receives those changes over a websocket connection to the Next.js backend.

## What It Shows

- a gallery of available sessions
- per-session iteration history
- tested `train.py` snapshots and diffs
- active tensions with thesis / antithesis code states
- transcendent artifacts
- execution metrics, summaries, and raw run logs

## Data Sources

The app reads from the repository root, specifically:

- `experiment_logs/`
- `runpod_runs/`

The app opens one internal websocket to the Next.js backend. The backend watches those directories with filesystem-level watches and pushes change notifications to the browser. It does not connect directly to Pods for viewer updates.

By default it tries to infer the repo root automatically:

- if the current working directory contains `pyproject.toml`, it uses that
- if the current working directory is `experiment-atlas/`, it uses the parent directory

You can override that explicitly with:

```bash
AUTORESEARCH_REPO_ROOT=/absolute/path/to/autoresearch
```

## Routes

- `/`
  Session gallery
- `/session/[id]`
  Session explorer in chronicle mode
- `/session/[id]/compare?tension=<tension-id>`
  Mirror view for comparing a selected tension

## Development

Install dependencies:

```bash
npm install
```

Run the app:

```bash
npm run dev
```

Then open:

```text
http://localhost:3000
```

If you are running the app from inside this repo, a typical command is:

```bash
cd experiment-atlas
npm run dev
```

If you want it to read a different checkout:

```bash
cd experiment-atlas
AUTORESEARCH_REPO_ROOT=/absolute/path/to/autoresearch npm run dev
```

## Notes

- This app is read-only. It does not launch experiments or modify session data.
- Canonical `experiment_logs/` sessions produce the richest UI.
- Fallback `runpod_runs/` sessions are still supported, but they may be missing tensions, transcendent artifacts, or full code state.
