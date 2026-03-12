# Experiment Atlas Plan

## Goal

Build a Next.js web app that acts as a data explorer for experiment session reports under `experiment_logs/<session-id>/`.

The app should not behave like a plain metrics dashboard. It should present each session as a research narrative composed of:

- iteration planning state
- active tensions
- thesis / antithesis code snapshots
- transcendent-function synthesis artifacts
- exact tested `train.py`
- final metrics
- keep / discard outcomes

The same dataset should support several different visual representations so the user can switch between chronological, structural, and dialectical views without changing the underlying source of truth.

## Product Idea

The working concept is **Experiment Atlas**.

Experiment Atlas treats each session as a traversable map of research decisions. Each iteration is a node with both numeric and conceptual state:

- what was predicted
- what was actually tested
- what contradicted the prior framing
- which tension it probed
- whether it exploited, negated, or synthesized
- whether the code state was kept or discarded

This makes the app useful for both:

- quick scanning of session progress
- deep inspection of why a research direction emerged or died

## Core Experience

The main session screen should have three persistent regions:

1. a left rail for session and iteration navigation
2. a central visual canvas with switchable views
3. a right inspection panel for metrics, code, diffs, and artifacts

The app should keep one shared selection state. Clicking an iteration in any view should update:

- the metrics panel
- the code snapshot viewer
- the tension metadata
- the transcendent artifact display
- the compare controls

## Visual Modes

All visual modes operate on the same normalized session graph.

### 1. Chronicle

A canonical timeline view.

Use this to show:

- iteration order
- `move_type`
- `prediction`
- `outcome`
- `keep_discard_status`
- headline metrics such as `val_bpb`, `peak_vram_mb`, `num_steps`, and `depth`

This is the default orientation view.

### 2. Dialectic Braid

Render thesis, antithesis, and synthesis as three intertwined lanes across iteration order.

Each iteration becomes a knot in the braid with:

- lane emphasis based on `move_type`
- color based on `confirmed`, `contradicted`, `mixed`, or `crash`
- hover details for prediction, contradiction, and next move

This view makes the research method itself visible.

### 3. Tension Constellation

Render active tensions as a network.

- tensions are nodes
- iterations are connected events
- edge style reflects `exploit`, `negate`, or `synthesize`
- node size reflects reuse across the session

This helps answer which tensions shaped the session most strongly.

### 4. Code Stratigraphy

Treat iterations as layers in a vertical stack.

- each layer represents one tested code state
- layer thickness reflects code churn or diff size
- layer color reflects outcome
- fractures or markers indicate discarded branches or contradicted assumptions

This makes the accumulation of code decisions visually tangible.

### 5. Decision Sankey

Show flow through the loop:

`parent_commit -> move_type -> outcome -> next_move_type -> kept/discarded`

This is useful for spotting repeated failure loops and successful research transitions.

### 6. Experiment Genome

Represent each iteration as a compact glyph encoding multiple metrics at once:

- `val_bpb`
- `peak_vram_mb`
- `depth`
- `num_params_M`
- `total_tokens_M`
- number of active tensions
- kept / discarded state

This supports dense comparison across long sessions.

### 7. Counterfactual Mirror

A comparison-first mode focused on one tension.

It should place:

- thesis on the left
- antithesis on the right
- synthesis in the center

Each panel can show:

- code snapshot
- metadata
- associated metrics
- explanatory text

This is the strongest view for transcendent-function analysis.

### 8. Narrative Filmstrip

A card-based sequence where each iteration is rendered as:

`prediction -> actual result -> contradicted assumption -> interpretation -> next move`

This is the best mode for reading a session as a compact research diary.

## Data Model

The frontend should normalize all loaded files into a single in-memory structure:

```ts
type SessionGraph = {
  session: SessionMeta
  manifest: ManifestMeta
  iterations: IterationNode[]
  tensions: TensionNode[]
  edges: SessionEdge[]
}
```

Key frontend entities:

- `IterationNode`
- `TensionNode`
- `TranscendentArtifact`
- `MetricSnapshot`
- `CodeSnapshot`
- `OutcomeTag`

The important design decision is that visualizations consume the normalized graph, not raw files directly.

## Source Inputs

Primary target inputs:

- `experiment_logs/<session-id>/manifest.json`
- `experiment_logs/<session-id>/session.json`
- `iterations/<n>/plan.json`
- `iterations/<n>/result.json`
- `iterations/<n>/actual/train.py`
- `iterations/<n>/actual/train.diff.patch`
- `iterations/<n>/tensions/*`
- `iterations/<n>/transcendent/result.json`
- `iterations/<n>/transcendent/train.py`
- `iterations/<n>/execution/*`

Near-term fallback inputs for current runs:

- `runpod_runs/*/metadata/summary.json`
- `runpod_runs/*/metadata/git-branch.json`
- `runpod_runs/*/artifacts/run.log`

This fallback should be treated as a compatibility adapter, not the long-term contract.

## Next.js App Structure

Use the App Router.

Suggested routes:

- `/` session gallery
- `/session/[id]` main explorer
- `/session/[id]/iteration/[iteration]` deep inspection route
- `/session/[id]/compare` focused compare view

Recommended structure:

- server components for filesystem reads and initial normalization
- client components for interactive views and linked highlighting
- route-level loading states for large sessions

## Main UI Areas

### Session Gallery

Shows all known sessions with:

- branch
- created date
- runner mode
- iteration count
- best iteration
- latest result status

### Iteration Rail

A compact vertical navigator listing:

- iteration number
- status pill
- move type
- kept / discarded flag
- primary metric delta

### Visual Canvas

Hosts the active visualization mode with shared hover and selection behavior.

### Inspector

Tabs:

- Metrics
- Plan
- Result
- Code
- Diff
- Tensions
- Transcendent
- Execution

## Comparison Workflows

The app should support these comparison tasks:

- compare any two iterations
- compare thesis vs antithesis for one tension
- compare a synthesized proposal against the iteration that tested it
- compare best-kept iteration vs latest iteration
- compare discarded experiments that later inspired a successful synthesis

## Visual Design Direction

Avoid generic dashboard styling.

The product should feel more like a research cartography tool than an admin panel:

- warm paper or lab-notebook base colors
- strong semantic accent colors for thesis, antithesis, and synthesis
- monospaced code areas with deliberate contrast
- subtle background grid, contour, or map-like texture
- restrained motion for transitions between views

Suggested semantic palette:

- thesis: deep blue
- antithesis: rust or crimson
- synthesis: green or brass
- contradiction: amber
- crash: charcoal
- keep: green
- discard: muted red

## Recommended MVP

Build only three views first:

1. Chronicle
2. Dialectic Braid
3. Counterfactual Mirror

MVP capabilities:

- load sessions from disk
- list iterations
- inspect `plan.json` and `result.json`
- display key metrics
- view exact `train.py`
- compare thesis / antithesis / synthesis snapshots

This is enough to prove the app is about research reasoning, not only experiment metrics.

## Implementation Phases

### Phase 1: Loader and schema adapter

- read `experiment_logs/`
- build `SessionGraph`
- add fallback adapter for existing `runpod_runs/`

### Phase 2: Explorer shell

- session gallery
- iteration rail
- inspector drawer
- shared selection state

### Phase 3: First visualization set

- Chronicle
- Dialectic Braid
- Counterfactual Mirror

### Phase 4: Deep inspection

- code snapshot viewer
- diff viewer
- tension browser
- transcendent artifact viewer

### Phase 5: Additional visual grammars

- Tension Constellation
- Code Stratigraphy
- Decision Sankey
- Experiment Genome
- Narrative Filmstrip

## Success Criteria

- a user can understand one session without opening Git
- a discarded iteration remains visually inspectable
- tensions are visible as first-class objects, not just tags
- synthesis artifacts are explorable beside their thesis and antithesis sources
- the same session can be understood through multiple visual modes
- the app remains useful during the transition from current `runpod_runs/` artifacts to full `experiment_logs/` coverage

## Naming

Working app name: **Experiment Atlas**

Alternatives:

- Dialectic Explorer
- Research Cartography
- Session Topography
- Tension Map
