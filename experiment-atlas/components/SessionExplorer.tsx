"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { startTransition, useDeferredValue, useEffect, useState } from "react";

import {
  formatCompactNumber,
  formatDateTime,
  formatDuration,
  formatMemoryGb,
  formatMetric,
  formatPercent,
  outcomeTone,
  titleCase,
  truncateText,
} from "@/lib/formatters";
import type {
  CodeSnapshot,
  CodexPhaseArtifact,
  IterationNode,
  LiveReflectionState,
  SessionGraph,
  TensionNode,
  TranscendentArtifact,
  VisualMode,
} from "@/lib/types";

type SessionExplorerProps = {
  session: SessionGraph;
  initialIterationLabel?: string;
  initialMode?: VisualMode;
  focusTensionId?: string;
};

type InspectorTab = "metrics" | "plan" | "result" | "code" | "diff" | "tensions" | "transcendent" | "execution";

const VIEW_OPTIONS: { id: VisualMode; label: string; description: string }[] = [
  { id: "chronicle", label: "Individuation Chronicle", description: "Metric timeline and moment-by-moment narrative" },
  { id: "braid", label: "Transcendent Braid", description: "Thesis / antithesis / synthesis movement" },
  { id: "mirror", label: "Shadow Mirror", description: "Compare thesis, synthesis, and antithesis" },
  { id: "constellation", label: "Complex Constellation", description: "Session complexes as a network around the selected moment" },
  { id: "stratigraphy", label: "Archetype Stratigraphy", description: "Code churn and outcomes as layered sediment" },
  { id: "sankey", label: "Libido Flow", description: "How attitudes move into outcomes and next movements" },
  { id: "genome", label: "Archetype Genome", description: "Dense glyph comparison across all moments" },
  { id: "filmstrip", label: "Dream Filmstrip", description: "A compact storyboard of foretelling, result, and dissonance" },
];

const INSPECTOR_TABS: InspectorTab[] = [
  "metrics",
  "plan",
  "result",
  "code",
  "diff",
  "tensions",
  "transcendent",
  "execution",
];

const INSPECTOR_TAB_LABELS: Record<InspectorTab, string> = {
  metrics: "Metrics",
  plan: "Plan",
  result: "Integration",
  code: "Embodied Code",
  diff: "Patch",
  tensions: "Complexes",
  transcendent: "Transcendent",
  execution: "Trace",
};

const INSPECTOR_TAB_DESCRIPTIONS: Record<InspectorTab, string> = {
  metrics: "Expanded metrics, vessel stats, and artifact context for the selected moment.",
  plan: "Prediction, preparation moves, and the staged Codex intervention before the run.",
  result: "Integrated outcome, reflected meaning, and post-run interpretation.",
  code: "The exact embodied train.py that animated this moment.",
  diff: "Mutation patch showing what changed relative to the prior state.",
  tensions: "Structured complexes captured for the current moment.",
  transcendent: "The emergent third image and its embodied synthesis.",
  execution: "Raw trace surfaces, metadata, relay state, and execution logs.",
};

function normalizeIterationLabel(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  if (/^\d+$/.test(value)) {
    return value.padStart(3, "0");
  }

  return value;
}

function laneForMoveType(moveType: string | null): "thesis" | "synthesis" | "antithesis" {
  switch (moveType) {
    case "negate":
      return "antithesis";
    case "synthesize":
      return "synthesis";
    default:
      return "thesis";
  }
}

function encodeQueryValue(value: string): string {
  return encodeURIComponent(value);
}

function splitHeroTitle(title: string): { prefix: string | null; focus: string } {
  const normalized = title.trim();
  if (!normalized) {
    return { prefix: null, focus: title };
  }

  const dateSuffixMatch = normalized.match(
    /^(.*?)(?:[-/])((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\d{1,2}(?:[-_]\d{4})?)$/i,
  );
  if (dateSuffixMatch) {
    const [, rawPrefix, rawFocus] = dateSuffixMatch;
    return {
      prefix: rawPrefix.replace(/[-/]+$/, "") || null,
      focus: rawFocus,
    };
  }

  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash > 0 && lastSlash < normalized.length - 1) {
    return {
      prefix: normalized.slice(0, lastSlash),
      focus: normalized.slice(lastSlash + 1),
    };
  }

  return { prefix: null, focus: normalized };
}

function HeroTitle({ title }: { title: string }) {
  const { prefix, focus } = splitHeroTitle(title);
  return (
    <h1 className="hero-title">
      {prefix ? <span className="hero-title-prefix">{prefix}</span> : null}
      <span className="hero-title-focus">{focus}</span>
    </h1>
  );
}

function summarizeExecution(iteration: IterationNode): string {
  const parts = [
    iteration.metrics.valBpb !== null ? `signal ${formatMetric(iteration.metrics.valBpb, 6)}` : null,
    iteration.metrics.peakVramMb !== null ? formatMemoryGb(iteration.metrics.peakVramMb) : null,
    iteration.metrics.totalTokensM !== null ? `${formatCompactNumber(iteration.metrics.totalTokensM)}M tokens` : null,
  ].filter((part): part is string => Boolean(part));

  return parts.join(" • ") || "No observable trace captured yet.";
}

function getCurrentRunProgress(session: SessionGraph): number {
  const progress = session.live?.progress?.progressPct;
  if (progress !== null && progress !== undefined) {
    return Math.max(0, Math.min(100, progress));
  }
  switch (session.live?.phase) {
    case "prepare":
      return 2;
    case "prepare_complete":
      return 5;
    case "deploy":
      return 8;
    case "reflect":
      return 98;
    case "reflect_complete":
    case "commit":
      return 100;
    default:
      return 100;
  }
}

function getOverallProgress(session: SessionGraph, currentRunProgress: number): number {
  const experimentIndex = session.live?.experimentIndex;
  const experimentCount = session.live?.experimentCount;
  if (!experimentIndex || !experimentCount) {
    return 100;
  }
  const completedBeforeCurrent = Math.max(experimentIndex - 1, 0);
  return Math.max(0, Math.min(100, ((completedBeforeCurrent + currentRunProgress / 100) / experimentCount) * 100));
}

function getSelectedTension(
  session: SessionGraph,
  selectedIteration: IterationNode,
  selectedTensionId: string,
): TensionNode | null {
  return (
    selectedIteration.tensions.find((tension) => tension.id === selectedTensionId) ??
    session.tensions.find((tension) => tension.id === selectedTensionId) ??
    selectedIteration.tensions[0] ??
    session.tensions[0] ??
    null
  );
}

function getMirrorArtifact(
  session: SessionGraph,
  selectedIteration: IterationNode,
  selectedTension: TensionNode | null,
): { iteration: IterationNode; artifact: TranscendentArtifact | null } {
  if (!selectedTension) {
    return {
      iteration: selectedIteration,
      artifact: selectedIteration.transcendent,
    };
  }

  const directHit =
    (selectedIteration.transcendent?.sourceTensionIds.includes(selectedTension.id) && selectedIteration.transcendent) ||
    null;

  if (directHit) {
    return {
      iteration: selectedIteration,
      artifact: directHit,
    };
  }

  const relatedIteration =
    session.iterations.find((iteration) => iteration.transcendent?.sourceTensionIds.includes(selectedTension.id)) ??
    session.iterations.find((iteration) => iteration.tensions.some((tension) => tension.id === selectedTension.id)) ??
    selectedIteration;

  return {
    iteration: relatedIteration,
    artifact: relatedIteration.transcendent,
  };
}

function valueOrFallback(value: string | null | undefined, fallback = "Not yet constellated"): string {
  return value ?? fallback;
}

function getSessionCurrentIteration(session: SessionGraph): IterationNode | null {
  if (session.live?.currentIterationLabel) {
    const current = session.iterations.find((iteration) => iteration.label === session.live?.currentIterationLabel);
    if (current) {
      return current;
    }
  }
  return session.iterations.at(-1) ?? null;
}

function getSessionStateKind(session: SessionGraph): "live" | "reconciled" | "historical" | "shadow" {
  if (session.live?.isActive) {
    return "live";
  }
  if (session.source !== "experiment_logs") {
    return "shadow";
  }
  const current = getSessionCurrentIteration(session);
  if (session.live?.currentIterationLabel && current?.label === session.live.currentIterationLabel) {
    return "reconciled";
  }
  return "historical";
}

function getExecutionMetaString(iteration: IterationNode | null, key: string): string | null {
  const metadata = iteration?.execution.metadata;
  const value = metadata?.[key];
  return typeof value === "string" && value ? value : null;
}

function SessionStateStrip({ session }: { session: SessionGraph }) {
  const current = getSessionCurrentIteration(session);
  const stateKind = getSessionStateKind(session);
  const reading =
    stateKind === "live"
      ? `Streaming into moment ${current?.label ?? session.live?.currentIterationLabel ?? "?"}`
      : stateKind === "reconciled"
        ? `Reconciled into moment ${current?.label ?? session.live?.currentIterationLabel ?? "?"}`
        : stateKind === "shadow"
          ? "Fallback trace without canonical psyche"
          : `Historical archive at moment ${current?.label ?? "?"}`;

  return (
    <section className="session-state-strip session-state-strip-wide">
      <div>
        <dt>State</dt>
        <dd>{titleCase(stateKind)}</dd>
      </div>
      <div>
        <dt>Moment</dt>
        <dd>{current?.label ?? "n/a"}</dd>
      </div>
      <div>
        <dt>Execution</dt>
        <dd>{truncateText(session.live?.executionId ?? getExecutionMetaString(current, "execution_id"), 28)}</dd>
      </div>
      <div>
        <dt>GPU</dt>
        <dd>{truncateText(getExecutionMetaString(current, "selected_gpu_type"), 28)}</dd>
      </div>
      <div>
        <dt>Signal</dt>
        <dd>{formatMetric(current?.metrics.valBpb ?? null, 6)}</dd>
      </div>
      <div>
        <dt>Reading</dt>
        <dd>{truncateText(reading, 40)}</dd>
      </div>
    </section>
  );
}

export function SessionExplorer({
  session,
  initialIterationLabel,
  initialMode = "chronicle",
  focusTensionId,
}: SessionExplorerProps) {
  const router = useRouter();
  const normalizedInitialIteration = normalizeIterationLabel(initialIterationLabel ?? session.live?.currentIterationLabel ?? undefined);
  const latestIteration = session.iterations.at(-1) ?? null;
  const initialIteration =
    session.iterations.find(
      (iteration) =>
        iteration.label === normalizedInitialIteration || String(iteration.iteration) === (initialIterationLabel ?? session.live?.currentIterationLabel),
    ) ?? latestIteration ?? session.iterations[0];
  const [selectedIterationId, setSelectedIterationId] = useState(initialIteration?.id ?? "");
  const [activeMode, setActiveMode] = useState<VisualMode>(initialMode);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("metrics");
  const [isInspectorFocusMinimized, setInspectorFocusMinimized] = useState(false);
  const [selectedTensionId, setSelectedTensionId] = useState(
    focusTensionId ?? initialIteration?.tensions[0]?.id ?? session.tensions[0]?.id ?? "",
  );
  const deferredIterationId = useDeferredValue(selectedIterationId);
  const selectedIteration =
    session.iterations.find((iteration) => iteration.id === deferredIterationId) ?? initialIteration ?? null;

  useEffect(() => {
    if (!session.live?.isActive) {
      return;
    }
    const handle = window.setInterval(() => {
      router.refresh();
    }, 5000);
    return () => window.clearInterval(handle);
  }, [router, session.live?.isActive]);

  if (!selectedIteration) {
    return (
      <main className="page-shell compact-shell">
        <section className="hero-panel">
          <p className="eyebrow">Experiment Atlas</p>
          <HeroTitle title={session.title} />
          <p className="lead">This constellation exists, but no readable moments were found.</p>
          <Link className="button-link" href="/">
            Return to atlas
          </Link>
        </section>
      </main>
    );
  }

  const selectedTension = getSelectedTension(session, selectedIteration, selectedTensionId);
  const mirror = getMirrorArtifact(session, selectedIteration, selectedTension);
  const sessionStateKind = getSessionStateKind(session);
  const inspectorFocusOpen = !isInspectorFocusMinimized;
  const selectCanvasMode = (mode: VisualMode) =>
    startTransition(() => {
      setActiveMode(mode);
      setInspectorFocusMinimized(true);
    });
  const selectCanvasIteration = (iterationId: string) =>
    startTransition(() => {
      setSelectedIterationId(iterationId);
      setInspectorFocusMinimized(true);
    });
  const selectCanvasTension = (tensionId: string) =>
    startTransition(() => {
      setSelectedTensionId(tensionId);
      setInspectorFocusMinimized(true);
    });

  return (
    <main className="page-shell explorer-shell">
      <section className="hero-panel hero-panel-tight">
        <div className="hero-copy">
          <p className="eyebrow">Experiment Atlas</p>
          <HeroTitle title={session.title} />
          <p className="lead">
            {session.branch} • {titleCase(session.runnerMode)} • {session.source === "runpod" ? "shadow trace" : "canonical psyche"}
          </p>
          <p className="session-summary-text">
            {session.source === "runpod"
              ? "This constellation is assembled from raw Runpod traces, so only metrics and logs are guaranteed as the observable record."
              : truncateText(session.notes, 160)}
          </p>
        </div>

        <div className="hero-actions">
          <Link className="button-link hero-action-card hero-action-atlas" href="/">
            <span className="hero-action-kicker">Atlas</span>
            <strong>All constellations</strong>
            <span className="hero-action-meta">Return to the wider field</span>
          </Link>
          <Link
            className="button-link button-link-subtle hero-action-card hero-action-moment"
            href={`/session/${session.id}/iteration/${selectedIteration.label}`}
          >
            <span className="hero-action-kicker">Moment</span>
            <strong>Selected moment</strong>
            <span className="hero-action-meta">Focus the current iteration</span>
          </Link>
          <Link
            className="button-link button-link-subtle hero-action-card hero-action-shadow"
            href={`/session/${session.id}/compare${selectedTension ? `?tension=${encodeQueryValue(selectedTension.id)}` : ""}`}
          >
            <span className="hero-action-kicker">Shadow</span>
            <strong>Shadow mirror</strong>
            <span className="hero-action-meta">Contrast the active poles</span>
          </Link>
        </div>

        <div className="hero-metrics hero-metrics-wide">
          <StatCard
            label={sessionStateKind === "live" ? "Live state" : sessionStateKind === "reconciled" ? "Reconciled state" : "Archive state"}
            value={sessionStateKind === "live" ? titleCase(session.live?.phase ?? null, "Running") : sessionStateKind === "reconciled" ? "Canonical sync" : "Historical"}
            detail={
              sessionStateKind === "live"
                ? `Moment ${session.live?.currentIterationLabel ?? selectedIteration.label}`
                : sessionStateKind === "reconciled"
                  ? `Synced to moment ${getSessionCurrentIteration(session)?.label ?? selectedIteration.label}`
                  : "Settled constellation"
            }
            tone={sessionStateKind === "live" ? "accent-antithesis" : sessionStateKind === "reconciled" ? "accent-synthesis" : "accent-neutral"}
          />
          <StatCard label="Moments" value={String(session.stats.iterationCount)} detail={formatDateTime(session.updatedAt)} tone="accent-thesis" />
          <StatCard
            label="Best signal"
            value={formatMetric(session.stats.bestValBpb, 6)}
            detail={session.stats.bestValBpb === null ? "Awaiting signal" : "Lower is better"}
            tone="accent-synthesis"
          />
          <StatCard
            label="Active complexes"
            value={String(session.stats.activeTensionCount)}
            detail={`${session.stats.confirmedCount} confirmed, ${session.stats.contradictionCount} contradicted`}
            tone="accent-antithesis"
          />
          <StatCard
            label="Selected moment"
            value={selectedIteration.label}
            detail={summarizeExecution(selectedIteration)}
            tone="accent-neutral"
          />
        </div>
        <SessionStateStrip session={session} />
        <LiveProgressPanel session={session} selectedIteration={selectedIteration} />
      </section>

      <section className="explorer-layout">
        <aside className="panel iteration-rail">
          <div className="rail-heading">
            <div>
              <p className="eyebrow">Moments</p>
              <h2>Individuation path</h2>
            </div>
            <span className="badge badge-outline">{session.stats.iterationCount}</span>
          </div>

          <div className="rail-list">
            {session.iterations.map((iteration) => {
              const isActive = iteration.id === selectedIteration.id;

              return (
                <button
                  key={iteration.id}
                  className={`rail-item ${isActive ? "rail-item-active" : ""} ${
                    session.live?.isActive && session.live.currentIterationLabel === iteration.label ? "rail-item-live" : ""
                  }`}
                  onClick={() => startTransition(() => setSelectedIterationId(iteration.id))}
                  type="button"
                >
                  <div className="rail-item-top">
                    <span className="rail-item-label">{iteration.label}</span>
                    <span className={`badge ${outcomeTone(iteration.keepDiscardStatus ?? iteration.outcome)}`}>
                      {titleCase(iteration.keepDiscardStatus ?? iteration.outcome, "Observed")}
                    </span>
                  </div>
                  <div className="rail-item-copy">
                    <strong>{titleCase(iteration.moveType, "Attitude")}</strong>
                    <p>{truncateText(iteration.prediction ?? iteration.summaryText, 72)}</p>
                  </div>
                  <div className="rail-item-meta">
                    <span>{formatMetric(iteration.metrics.valBpb, 6)}</span>
                    <span>
                      {session.live?.isActive && session.live.currentIterationLabel === iteration.label
                        ? `${Math.round(session.live.progress?.progressPct ?? 0)}% live`
                        : formatMemoryGb(iteration.metrics.peakVramMb)}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </aside>

        <section className="canvas-column">
          <div className="panel view-panel">
            <div className="view-toolbar">
              <div className="view-toolbar-copy">
                <p className="eyebrow">Symbolic Canvas</p>
                <h2>{VIEW_OPTIONS.find((view) => view.id === activeMode)?.label}</h2>
                <p>{VIEW_OPTIONS.find((view) => view.id === activeMode)?.description}</p>
              </div>

              <div className="view-toolbar-actions">
                {VIEW_OPTIONS.map((view) => (
                  <button
                    key={view.id}
                    className={`toolbar-chip ${activeMode === view.id ? "toolbar-chip-active" : ""}`}
                    onClick={() => selectCanvasMode(view.id)}
                    type="button"
                  >
                    {view.label}
                  </button>
                ))}
              </div>
            </div>

            {inspectorFocusOpen ? (
              <section className="inspector-focus-panel">
                <div className="inspector-focus-header">
                  <div>
                    <p className="eyebrow">Expanded analytic card</p>
                    <h3>{INSPECTOR_TAB_LABELS[inspectorTab]}</h3>
                    <p className="muted">{INSPECTOR_TAB_DESCRIPTIONS[inspectorTab]}</p>
                  </div>
                  <button
                    aria-label="Minimize analytic card"
                    className="inspector-focus-dismiss"
                    onClick={() => setInspectorFocusMinimized(true)}
                    type="button"
                  >
                    <span aria-hidden="true">×</span>
                  </button>
                </div>
                <InspectorPanel
                  session={session}
                  iteration={selectedIteration}
                  selectedTension={selectedTension}
                  tab={inspectorTab}
                />
              </section>
            ) : null}

            {activeMode === "chronicle" ? (
              <ChronicleView
                iterations={session.iterations}
                selectedIteration={selectedIteration}
                onSelectIteration={selectCanvasIteration}
              />
            ) : null}

            {activeMode === "braid" ? (
              <DialecticBraidView
                iterations={session.iterations}
                selectedIteration={selectedIteration}
                onSelectIteration={selectCanvasIteration}
              />
            ) : null}

            {activeMode === "mirror" ? (
              <CounterfactualMirrorView
                session={session}
                selectedIteration={selectedIteration}
                selectedTension={selectedTension}
                selectedTensionId={selectedTensionId}
                mirror={mirror}
                onSelectTension={selectCanvasTension}
              />
            ) : null}

            {activeMode === "constellation" ? (
              <TensionConstellationView
                session={session}
                selectedIteration={selectedIteration}
                selectedTension={selectedTension}
                onSelectTension={selectCanvasTension}
              />
            ) : null}

            {activeMode === "stratigraphy" ? (
              <CodeStratigraphyView
                iterations={session.iterations}
                selectedIteration={selectedIteration}
                onSelectIteration={selectCanvasIteration}
              />
            ) : null}

            {activeMode === "sankey" ? (
              <DecisionSankeyView iterations={session.iterations} selectedIteration={selectedIteration} />
            ) : null}

            {activeMode === "genome" ? (
              <ExperimentGenomeView
                iterations={session.iterations}
                selectedIteration={selectedIteration}
                onSelectIteration={selectCanvasIteration}
              />
            ) : null}

            {activeMode === "filmstrip" ? (
              <NarrativeFilmstripView
                iterations={session.iterations}
                selectedIteration={selectedIteration}
                onSelectIteration={selectCanvasIteration}
              />
            ) : null}
          </div>
        </section>

        <aside className="panel inspector-card">
          <div className="inspector-heading">
            <div>
              <p className="eyebrow">Analytic Frame</p>
              <h2>Moment {selectedIteration.label}</h2>
            </div>
            <span className={`badge ${outcomeTone(selectedIteration.keepDiscardStatus ?? selectedIteration.outcome)}`}>
              {titleCase(selectedIteration.keepDiscardStatus ?? selectedIteration.outcome, "Observed")}
            </span>
          </div>

          <div className="tab-strip">
            {INSPECTOR_TABS.map((tab) => (
              <button
                key={tab}
                className={`tab-chip ${inspectorTab === tab ? "tab-chip-active" : ""}`}
                onClick={() =>
                  startTransition(() => {
                    setInspectorTab(tab);
                    setInspectorFocusMinimized(false);
                  })
                }
                type="button"
              >
                {INSPECTOR_TAB_LABELS[tab]}
              </button>
            ))}
          </div>

          <div className="inspector-summary-card">
            <div className="panel-block-top">
              <h3>{INSPECTOR_TAB_LABELS[inspectorTab]}</h3>
              <span className={`badge ${inspectorFocusOpen ? "badge-live" : "badge-outline"}`}>
                {inspectorFocusOpen ? "Expanded" : "Minimized"}
              </span>
            </div>
            <p className="muted">{INSPECTOR_TAB_DESCRIPTIONS[inspectorTab]}</p>
            <dl className="detail-list compact-detail-list">
              <div>
                <dt>Signal</dt>
                <dd>{formatMetric(selectedIteration.metrics.valBpb, 6)}</dd>
              </div>
              <div>
                <dt>Result</dt>
                <dd>{titleCase(selectedIteration.keepDiscardStatus ?? selectedIteration.outcome, "Observed")}</dd>
              </div>
              <div>
                <dt>Canvas panel</dt>
                <dd>{inspectorFocusOpen ? "Open in symbolic frame" : "Use any tab to reopen"}</dd>
              </div>
            </dl>
          </div>
        </aside>
      </section>
    </main>
  );
}

function StatCard({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  tone: string;
}) {
  return (
    <div className={`metric-card ${tone}`}>
      <span className="metric-label">{label}</span>
      <strong>{value}</strong>
      <span className="metric-detail">{detail}</span>
    </div>
  );
}

function LiveProgressPanel({ session, selectedIteration }: { session: SessionGraph; selectedIteration: IterationNode }) {
  const currentRunProgress = getCurrentRunProgress(session);
  const overallProgress = getOverallProgress(session, currentRunProgress);

  return (
    <div className="live-progress-panel">
      <div className="progress-row">
        <div className="progress-copy">
          <span className="progress-label">Current 5-minute vessel</span>
          <strong>{Math.round(currentRunProgress)}%</strong>
        </div>
        <span className="progress-meta">
          {session.live?.isActive
            ? session.live.progress?.step !== null && session.live.progress?.step !== undefined
              ? `Step ${session.live.progress.step} • ${session.live.progress.remainingSeconds ?? "?"}s remaining`
              : titleCase(session.live.phase, "Preparing")
            : `Moment ${selectedIteration.label} archived`}
        </span>
      </div>
      <div className="progress-bar">
        <span className="progress-fill" style={{ width: `${currentRunProgress}%` }} />
      </div>

      <div className="progress-row progress-row-compact">
        <div className="progress-copy">
          <span className="progress-label">Overall scope</span>
          <strong>{Math.round(overallProgress)}%</strong>
        </div>
        <span className="progress-meta">
          {session.live?.experimentIndex && session.live?.experimentCount
            ? `Experiment ${session.live.experimentIndex}/${session.live.experimentCount}`
            : `${session.stats.iterationCount} total moments`}
        </span>
      </div>
      <div className="progress-bar progress-bar-subtle">
        <span className="progress-fill progress-fill-scope" style={{ width: `${overallProgress}%` }} />
      </div>
      {session.live?.isActive && session.live.progress ? (
        <dl className="live-metric-strip live-metric-strip-dense">
          <div>
            <dt>Loss</dt>
            <dd>{formatMetric(session.live.progress.trainLoss, 4)}</dd>
          </div>
          <div>
            <dt>Tok/s</dt>
            <dd>{formatMetric(session.live.progress.tokensPerSecond, 0)}</dd>
          </div>
          <div>
            <dt>MFU</dt>
            <dd>{formatMetric(session.live.progress.mfuPercent, 1)}%</dd>
          </div>
          <div>
            <dt>VRAM</dt>
            <dd>{formatMemoryGb(session.live.progress.currentVramMb)}</dd>
          </div>
          <div>
            <dt>GPU</dt>
            <dd>{formatPercent(session.live.progress.gpuUtilPercent)}</dd>
          </div>
          <div>
            <dt>Backend</dt>
            <dd>{titleCase(session.live.attentionBackend, "pending")}</dd>
          </div>
          <div>
            <dt>Depth</dt>
            <dd>{formatMetric(session.live.depth, 0)}</dd>
          </div>
        </dl>
      ) : null}
      {session.live?.lastEventType === "eval_started" ? (
        <p className="live-phase-note">Evaluating final BPB...</p>
      ) : null}
      {session.live?.lastEventType === "run_summary" && session.live?.progress && session.live.progress.valBpb !== null ? (
        <p className="live-phase-note">
          Final signal {formatMetric(session.live.progress.valBpb, 6)} captured. Awaiting reflection.
        </p>
      ) : null}
      {session.live?.reflection ? (
        <p className="live-phase-note">
          Reflection landed as {titleCase(session.live.reflection.keepDiscardStatus, "Observed")} with{" "}
          {titleCase(session.live.reflection.nextMoveType, "no next move")} next.
        </p>
      ) : null}
    </div>
  );
}

function isLiveIteration(session: SessionGraph, iteration: IterationNode): boolean {
  return Boolean(session.live?.isActive && session.live.currentIterationLabel === iteration.label);
}

function liveReflectionForIteration(session: SessionGraph, iteration: IterationNode): LiveReflectionState | null {
  if (!isLiveIteration(session, iteration)) {
    return null;
  }
  return session.live?.reflection ?? null;
}

function getRelayGpuValue(source: Record<string, unknown> | null, key: string): number | null {
  if (!source) {
    return null;
  }
  const currentGpu = source.current_gpu;
  if (!currentGpu || typeof currentGpu !== "object" || Array.isArray(currentGpu)) {
    return null;
  }
  const value = (currentGpu as Record<string, unknown>)[key];
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function LiveGpuPanel({
  session,
  iteration,
}: {
  session: SessionGraph;
  iteration: IterationNode;
}) {
  const live = isLiveIteration(session, iteration) ? session.live : null;
  const relayState = iteration.execution.relayState ?? null;
  const progress = live?.progress ?? null;
  const allocated = progress?.currentVramMb ?? getRelayGpuValue(relayState, "memory_used_mb");
  const reserved = progress?.reservedVramMb ?? null;
  const peak = progress?.peakVramMb ?? null;
  const gpuUtil = progress?.gpuUtilPercent ?? getRelayGpuValue(relayState, "util_percent");
  const gpuMemUtil = progress?.gpuMemoryUtilPercent ?? getRelayGpuValue(relayState, "mem_util_percent");
  const tempC = progress?.tempC ?? getRelayGpuValue(relayState, "temp_c");
  const powerW = progress?.powerW ?? getRelayGpuValue(relayState, "power_w");

  if ([allocated, reserved, peak, gpuUtil, gpuMemUtil, tempC, powerW].every((value) => value === null)) {
    return null;
  }

  return (
    <section className="panel-block">
      <div className="panel-block-top">
        <h3>GPU vessel</h3>
        <span className="badge badge-outline">{live ? "Live" : "Archived"}</span>
      </div>
      <div className="note-grid inspector-metric-grid">
        <MetricDatum label="Allocated" value={formatMemoryGb(allocated)} />
        <MetricDatum label="Reserved" value={formatMemoryGb(reserved)} />
        <MetricDatum label="Peak" value={formatMemoryGb(peak)} />
        <MetricDatum label="GPU util" value={formatPercent(gpuUtil)} />
        <MetricDatum label="Mem util" value={formatPercent(gpuMemUtil)} />
        <MetricDatum label="Temp" value={tempC !== null ? `${tempC.toFixed(0)} C` : "n/a"} />
        <MetricDatum label="Power" value={powerW !== null ? `${powerW.toFixed(0)} W` : "n/a"} />
      </div>
    </section>
  );
}

function LiveReflectionPanel({ reflection }: { reflection: LiveReflectionState }) {
  return (
    <section className="panel-block">
      <div className="panel-block-top">
        <h3>Live reflected meaning</h3>
        <span className="badge badge-live">Live</span>
      </div>
      <div className="note-grid">
        <NarrativeCard title="Outcome" body={reflection.outcome} tone="accent-neutral" />
        <NarrativeCard title="Framing diagnosis" body={reflection.framingDiagnosis} tone="accent-antithesis" />
        <NarrativeCard title="Wounded assumption" body={reflection.contradictedAssumption} tone="accent-antithesis" />
        <NarrativeCard title="Emergent thought" body={reflection.transcendentThought} tone="accent-synthesis" />
      </div>
      <dl className="detail-list compact-detail-list">
        <div>
          <dt>Integration status</dt>
          <dd>{titleCase(reflection.keepDiscardStatus, "Not set")}</dd>
        </div>
        <div>
          <dt>Next movement</dt>
          <dd>{titleCase(reflection.nextMoveType, "Not set")}</dd>
        </div>
        <div>
          <dt>Result status</dt>
          <dd>{titleCase(reflection.resultStatus, "Not set")}</dd>
        </div>
        <div>
          <dt>Modified files</dt>
          <dd>{reflection.modifiedFiles.length ? reflection.modifiedFiles.join(", ") : "No file changes captured"}</dd>
        </div>
      </dl>
    </section>
  );
}

function summarizePatch(snapshot: CodeSnapshot): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of (snapshot.content ?? "").split("\n")) {
    if (line.startsWith("+++ ") || line.startsWith("--- ")) {
      continue;
    }
    if (line.startsWith("+")) {
      additions += 1;
    } else if (line.startsWith("-")) {
      deletions += 1;
    }
  }
  return { additions, deletions };
}

function CompactPatchViewer({ phaseArtifact }: { phaseArtifact: CodexPhaseArtifact }) {
  if (!phaseArtifact.patches.length) {
    return null;
  }

  return (
    <div className="patch-stack">
      {phaseArtifact.patches.map((patch) => {
        const stats = summarizePatch(patch);
        return (
          <details key={patch.path ?? patch.label} className="patch-drawer">
            <summary className="patch-summary">
              <span className="patch-summary-copy">
                <strong>{patch.path?.split("/").pop() ?? patch.label}</strong>
                <span>{patch.path ?? "Patch artifact"}</span>
              </span>
              <span className="patch-summary-stats">
                <span>+{stats.additions}</span>
                <span>-{stats.deletions}</span>
              </span>
            </summary>
            <pre className="code-frame code-frame-compact">
              <code>{patch.content ?? "No patch contents captured."}</code>
            </pre>
          </details>
        );
      })}
    </div>
  );
}

function ChronicleView({
  iterations,
  selectedIteration,
  onSelectIteration,
}: {
  iterations: IterationNode[];
  selectedIteration: IterationNode;
  onSelectIteration: (iterationId: string) => void;
}) {
  const width = 980;
  const height = 330;
  const paddingX = 64;
  const paddingY = 36;
  const chartBottom = 272;
  const measured = iterations.map((iteration) => iteration.metrics.valBpb).filter((value): value is number => value !== null);
  const minValue = measured.length ? Math.min(...measured) : 0.99;
  const maxValue = measured.length ? Math.max(...measured) : 1.01;
  const valueSpread = Math.max(maxValue - minValue, 0.0025);
  const tokenValues = iterations
    .map((iteration) => iteration.metrics.totalTokensM)
    .filter((value): value is number => value !== null);
  const tokenMax = tokenValues.length ? Math.max(...tokenValues) : 1;

  const points = iterations.map((iteration, index) => {
    const x =
      iterations.length === 1
        ? width / 2
        : paddingX + (index / Math.max(iterations.length - 1, 1)) * (width - paddingX * 2);
    const value = iteration.metrics.valBpb ?? maxValue + valueSpread * 0.2;
    const y = paddingY + ((value - minValue) / valueSpread) * (chartBottom - paddingY);
    const barHeight =
      iteration.metrics.totalTokensM !== null ? (iteration.metrics.totalTokensM / tokenMax) * 72 : 12;

    return {
      iteration,
      x,
      y,
      barHeight,
    };
  });

  const chartPath = points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
    .join(" ");
  const tickValues = [minValue, minValue + valueSpread / 2, maxValue];

  return (
    <div className="view-stack">
      <svg className="chart-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Chronicle chart">
        <defs>
          <linearGradient id="chronicleLine" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="var(--atlas-thesis)" />
            <stop offset="100%" stopColor="var(--atlas-synthesis)" />
          </linearGradient>
        </defs>

        <rect x="0" y="0" width={width} height={height} fill="transparent" />

        {tickValues.map((tick, index) => {
          const y = paddingY + ((tick - minValue) / valueSpread) * (chartBottom - paddingY);
          return (
            <g key={tick}>
              <line x1={paddingX} x2={width - paddingX} y1={y} y2={y} className="chart-gridline" />
              <text x={14} y={y + 5} className="chart-label">
                {formatMetric(tick, 6)}
              </text>
              {index === 0 ? null : (
                <text x={width - paddingX + 8} y={y + 5} className="chart-label">
                  {index === tickValues.length - 1 ? "Earlier shadow" : "Midline"}
                </text>
              )}
            </g>
          );
        })}

        {points.map((point) => (
          <rect
            key={`${point.iteration.id}-bar`}
            x={point.x - 15}
            y={chartBottom - point.barHeight}
            width={30}
            height={point.barHeight}
            rx={8}
            className="chart-bar"
          />
        ))}

        <path d={chartPath} className="chart-line" stroke="url(#chronicleLine)" />

        {points.map((point) => {
          const active = point.iteration.id === selectedIteration.id;
          return (
            <g key={point.iteration.id}>
              <line x1={point.x} x2={point.x} y1={chartBottom + 8} y2={chartBottom + 16} className="chart-axis-tick" />
              <text x={point.x} y={chartBottom + 34} textAnchor="middle" className="chart-axis-label">
                {point.iteration.label}
              </text>
              <circle
                cx={point.x}
                cy={point.y}
                r={active ? 11 : 8}
                className={`chart-point ${active ? "chart-point-active" : ""}`}
                onClick={() => onSelectIteration(point.iteration.id)}
              />
            </g>
          );
        })}
      </svg>

      <div className="note-grid">
        <NarrativeCard title="Foretelling" body={selectedIteration.prediction} tone="accent-thesis" />
        <NarrativeCard title="Observed result" body={selectedIteration.outcome ?? selectedIteration.status} tone="accent-neutral" />
        <NarrativeCard
          title="Dissonance"
          body={selectedIteration.contradictedAssumption ?? selectedIteration.summaryText}
          tone="accent-antithesis"
        />
        <NarrativeCard title="Next movement" body={selectedIteration.nextMoveType ?? selectedIteration.moveType} tone="accent-synthesis" />
      </div>
    </div>
  );
}

function DialecticBraidView({
  iterations,
  selectedIteration,
  onSelectIteration,
}: {
  iterations: IterationNode[];
  selectedIteration: IterationNode;
  onSelectIteration: (iterationId: string) => void;
}) {
  const width = 980;
  const height = 330;
  const paddingX = 52;
  const lanes = {
    thesis: 78,
    synthesis: 164,
    antithesis: 250,
  };

  const points = iterations.map((iteration, index) => {
    const x =
      iterations.length === 1
        ? width / 2
        : paddingX + (index / Math.max(iterations.length - 1, 1)) * (width - paddingX * 2);
    const lane = laneForMoveType(iteration.moveType);
    return {
      iteration,
      lane,
      x,
      y: lanes[lane],
    };
  });

  const threadPath = points
    .map((point, index) => {
      if (index === 0) {
        return `M ${point.x.toFixed(1)} ${point.y.toFixed(1)}`;
      }

      const previous = points[index - 1];
      const controlX = ((previous.x + point.x) / 2).toFixed(1);
      return `Q ${controlX} ${previous.y.toFixed(1)} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <div className="view-stack">
      <svg className="chart-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Transcendent braid view">
        <path d={`M ${paddingX} ${lanes.thesis} C 280 ${lanes.thesis - 16}, 700 ${lanes.thesis + 16}, ${width - paddingX} ${lanes.thesis}`} className="lane-path thesis-lane" />
        <path d={`M ${paddingX} ${lanes.synthesis} C 300 ${lanes.synthesis - 12}, 680 ${lanes.synthesis + 12}, ${width - paddingX} ${lanes.synthesis}`} className="lane-path synthesis-lane" />
        <path d={`M ${paddingX} ${lanes.antithesis} C 280 ${lanes.antithesis - 16}, 700 ${lanes.antithesis + 16}, ${width - paddingX} ${lanes.antithesis}`} className="lane-path antithesis-lane" />

        <text x={paddingX} y={lanes.thesis - 26} className="chart-lane-label">
          Thesis / exploit
        </text>
        <text x={paddingX} y={lanes.synthesis - 26} className="chart-lane-label">
          Transcendent function / merge
        </text>
        <text x={paddingX} y={lanes.antithesis - 26} className="chart-lane-label">
          Antithesis / negate
        </text>

        <path d={threadPath} className="braid-thread" />

        {points.map((point) => {
          const active = point.iteration.id === selectedIteration.id;
          return (
            <g key={point.iteration.id} onClick={() => onSelectIteration(point.iteration.id)}>
              <circle cx={point.x} cy={point.y} r={active ? 15 : 11} className="braid-knot-shadow" />
              <circle
                cx={point.x}
                cy={point.y}
                r={active ? 12 : 9}
                className={`braid-knot ${outcomeTone(point.iteration.outcome ?? point.iteration.keepDiscardStatus)}`}
              />
              <text x={point.x} y={point.y + 4} textAnchor="middle" className="braid-knot-label">
                {point.iteration.label}
              </text>
            </g>
          );
        })}
      </svg>

      <div className="braid-summary">
        <div className="legend-strip">
          <span className="legend-chip legend-chip-thesis">Thesis</span>
          <span className="legend-chip legend-chip-synthesis">Transcendent function</span>
          <span className="legend-chip legend-chip-antithesis">Antithesis</span>
        </div>
        <p className="muted">
          The thread shows how the session held the tension of opposites through exploitation, direct negation, and synthesis. Each knot is color-coded by outcome and keeps the moment ordering intact.
        </p>
        <div className="selected-summary-card">
          <h3>Moment {selectedIteration.label}</h3>
          <p>{truncateText(selectedIteration.prediction ?? selectedIteration.summaryText, 140)}</p>
          <dl className="inline-stats">
            <div>
              <dt>Attitude</dt>
              <dd>{titleCase(selectedIteration.moveType, "Attitude")}</dd>
            </div>
            <div>
              <dt>Result</dt>
              <dd>{titleCase(selectedIteration.outcome ?? selectedIteration.keepDiscardStatus, "Observed")}</dd>
            </div>
            <div>
              <dt>Signal</dt>
              <dd>{formatMetric(selectedIteration.metrics.valBpb, 6)}</dd>
            </div>
          </dl>
        </div>
      </div>
    </div>
  );
}

function CounterfactualMirrorView({
  session,
  selectedIteration,
  selectedTension,
  selectedTensionId,
  mirror,
  onSelectTension,
}: {
  session: SessionGraph;
  selectedIteration: IterationNode;
  selectedTension: TensionNode | null;
  selectedTensionId: string;
  mirror: { iteration: IterationNode; artifact: TranscendentArtifact | null };
  onSelectTension: (tensionId: string) => void;
}) {
  if (!session.tensions.length) {
    return (
      <div className="view-stack">
        <div className="empty-state large-empty-state">
          <p>No structured complexes have been constellated for this session yet.</p>
          <p className="muted">
            The mirror view will become richer once canonical logs include thesis and antithesis snapshots under
            <code>tensions/*</code>.
          </p>
        </div>
        <CodePanel title="Current embodied code" snapshot={selectedIteration.actualCode} compact />
      </div>
    );
  }

  return (
    <div className="view-stack">
      <div className="mirror-toolbar">
        <label className="field-label" htmlFor="tension-select">
          Focus complex
        </label>
        <select
          className="atlas-select"
          id="tension-select"
          onChange={(event) => onSelectTension(event.target.value)}
          value={selectedTensionId || selectedTension?.id || ""}
        >
          {session.tensions.map((tension) => (
            <option key={tension.id} value={tension.id}>
              {tension.label}
            </option>
          ))}
        </select>
      </div>

      <div className="mirror-grid">
        <MirrorColumn
          title="Thesis"
          subtitle={selectedTension?.label ?? "Current dominant attitude"}
          tone="mirror-thesis"
          summary={selectedTension?.whyActive}
          code={selectedTension?.thesis}
        />

        <MirrorColumn
          title="Synthesis"
          subtitle={`Moment ${mirror.iteration.label}`}
          tone="mirror-synthesis"
          summary={mirror.artifact?.emergentThought ?? mirror.iteration.summaryText ?? mirror.iteration.prediction}
          code={mirror.artifact?.code ?? mirror.iteration.actualCode}
          footer={`Status: ${titleCase(mirror.artifact?.resultStatus ?? mirror.iteration.outcome, "Observed")}`}
        />

        <MirrorColumn
          title="Antithesis"
          subtitle={selectedTension?.kind ?? "Opposing pole"}
          tone="mirror-antithesis"
          summary={selectedTension?.favoredSide ? `Favored side: ${selectedTension.favoredSide}` : selectedTension?.whyActive}
          code={selectedTension?.antithesis}
        />
      </div>
    </div>
  );
}

function MirrorColumn({
  title,
  subtitle,
  summary,
  code,
  footer,
  tone,
}: {
  title: string;
  subtitle: string;
  summary: string | null | undefined;
  code: CodeSnapshot | null | undefined;
  footer?: string;
  tone: string;
}) {
  return (
    <article className={`mirror-column ${tone}`}>
      <div className="mirror-column-heading">
        <p className="eyebrow">{title}</p>
        <h3>{subtitle}</h3>
      </div>
      <p className="mirror-column-copy">{valueOrFallback(summary)}</p>
      <CodePanel title={code?.label ?? "Code"} snapshot={code ?? null} compact />
      {footer ? <p className="mirror-footer">{footer}</p> : null}
    </article>
  );
}

function TensionConstellationView({
  session,
  selectedIteration,
  selectedTension,
  onSelectTension,
}: {
  session: SessionGraph;
  selectedIteration: IterationNode;
  selectedTension: TensionNode | null;
  onSelectTension: (tensionId: string) => void;
}) {
  if (!session.tensions.length) {
    return (
      <div className="empty-state large-empty-state">
        <p>No structured complex constellation is available for this session yet.</p>
      </div>
    );
  }

  const width = 980;
  const height = 360;
  const centerX = width / 2;
  const centerY = height / 2;
  const radius = 132;
  const activeTensionIds = new Set(selectedIteration.activeTensionIds);
  const points = session.tensions.map((tension, index) => {
    const angle = (-Math.PI / 2) + (index / Math.max(session.tensions.length, 1)) * Math.PI * 2;
    const x = centerX + Math.cos(angle) * radius;
    const y = centerY + Math.sin(angle) * radius;
    const weight = Math.min(30, 12 + tension.iterationRefs.length * 2.5);
    const isActive = activeTensionIds.has(tension.id) || selectedIteration.tensions.some((item) => item.id === tension.id);

    return {
      tension,
      x,
      y,
      weight,
      isActive,
    };
  });

  return (
    <div className="view-stack">
      <svg className="chart-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Complex constellation">
        <circle cx={centerX} cy={centerY} r="80" className="constellation-core" />
        <text x={centerX} y={centerY - 6} textAnchor="middle" className="constellation-core-label">
          Moment {selectedIteration.label}
        </text>
        <text x={centerX} y={centerY + 18} textAnchor="middle" className="chart-axis-label">
          {titleCase(selectedIteration.moveType, "Attitude")}
        </text>

        {points.map((point) => (
          <g key={point.tension.id}>
            <line
              x1={centerX}
              y1={centerY}
              x2={point.x}
              y2={point.y}
              className={`constellation-edge ${point.isActive ? "constellation-edge-active" : ""}`}
            />
            <circle
              cx={point.x}
              cy={point.y}
              r={point.weight}
              className={`constellation-node ${point.isActive ? "constellation-node-active" : ""} ${
                selectedTension?.id === point.tension.id ? "constellation-node-selected" : ""
              }`}
              onClick={() => onSelectTension(point.tension.id)}
            />
            <text x={point.x} y={point.y + 3} textAnchor="middle" className="constellation-node-label">
              {point.tension.label}
            </text>
          </g>
        ))}
      </svg>

      <div className="note-grid">
        <NarrativeCard title="Focused complex" body={selectedTension?.label} tone="accent-thesis" />
        <NarrativeCard title="Why active" body={selectedTension?.whyActive} tone="accent-neutral" />
        <NarrativeCard
          title="Dominant side"
          body={selectedTension?.favoredSide ? `Favored: ${selectedTension.favoredSide}` : selectedTension?.kind}
          tone="accent-antithesis"
        />
        <NarrativeCard
          title="Reuse"
          body={
            selectedTension
              ? `Appears in ${selectedTension.iterationRefs.length} moment${selectedTension.iterationRefs.length === 1 ? "" : "s"}`
              : null
          }
          tone="accent-synthesis"
        />
      </div>
    </div>
  );
}

function CodeStratigraphyView({
  iterations,
  selectedIteration,
  onSelectIteration,
}: {
  iterations: IterationNode[];
  selectedIteration: IterationNode;
  onSelectIteration: (iterationId: string) => void;
}) {
  const heights = iterations.map((iteration) => {
    const diffLines = iteration.diff?.content?.split("\n").length ?? 0;
    const codeLines = iteration.actualCode?.content?.split("\n").length ?? 0;
    return Math.max(68, Math.min(168, 54 + diffLines * 1.1 || 54 + codeLines * 0.18));
  });
  const maxHeight = Math.max(...heights, 1);

  return (
    <div className="view-stack">
      <div className="stratigraphy-stack">
        {iterations.map((iteration, index) => {
          const height = heights[index];
          const emphasis = height / maxHeight;
          return (
            <button
              key={iteration.id}
              className={`stratigraphy-layer ${iteration.id === selectedIteration.id ? "stratigraphy-layer-active" : ""}`}
              onClick={() => onSelectIteration(iteration.id)}
              style={{
                minHeight: `${height}px`,
                opacity: 0.74 + emphasis * 0.26,
              }}
              type="button"
            >
              <div className="stratigraphy-layer-top">
                <span className="badge badge-outline">{iteration.label}</span>
                <span className={`badge ${outcomeTone(iteration.keepDiscardStatus ?? iteration.outcome)}`}>
                  {titleCase(iteration.keepDiscardStatus ?? iteration.outcome, "Observed")}
                </span>
              </div>
              <h3>{titleCase(iteration.moveType, "Attitude")}</h3>
              <p>{truncateText(iteration.prediction ?? iteration.summaryText, 100)}</p>
              <div className="stratigraphy-meta">
                <span>{formatMetric(iteration.metrics.valBpb, 6)}</span>
                <span>{iteration.diff?.content?.split("\n").length ?? 0} diff lines</span>
              </div>
            </button>
          );
        })}
      </div>
      <p className="muted">
        Layer height reflects code churn. Thick strata indicate larger diffs or broader code snapshots, while color
        still tracks keep/discard outcome.
      </p>
    </div>
  );
}

function DecisionSankeyView({
  iterations,
  selectedIteration,
}: {
  iterations: IterationNode[];
  selectedIteration: IterationNode;
}) {
  const width = 980;
  const height = 360;
  const columns = [170, 490, 810];
  const moveLabels = [...new Set(iterations.map((iteration) => titleCase(iteration.moveType, "Observe")))];
  const outcomeLabels = [...new Set(iterations.map((iteration) => titleCase(iteration.outcome ?? iteration.keepDiscardStatus, "Observed")))];
  const nextLabels = [...new Set(iterations.map((iteration) => titleCase(iteration.nextMoveType ?? iteration.keepDiscardStatus, "Hold")))];

  const movePositions = new Map(moveLabels.map((label, index) => [label, 70 + index * 84]));
  const outcomePositions = new Map(outcomeLabels.map((label, index) => [label, 70 + index * 84]));
  const nextPositions = new Map(nextLabels.map((label, index) => [label, 70 + index * 84]));

  const flows = iterations.flatMap((iteration) => {
    const move = titleCase(iteration.moveType, "Observe");
    const outcome = titleCase(iteration.outcome ?? iteration.keepDiscardStatus, "Observed");
    const next = titleCase(iteration.nextMoveType ?? iteration.keepDiscardStatus, "Hold");

    return [
      {
        fromX: columns[0],
        fromY: movePositions.get(move) ?? 70,
        toX: columns[1],
        toY: outcomePositions.get(outcome) ?? 70,
        highlight: iteration.id === selectedIteration.id,
      },
      {
        fromX: columns[1],
        fromY: outcomePositions.get(outcome) ?? 70,
        toX: columns[2],
        toY: nextPositions.get(next) ?? 70,
        highlight: iteration.id === selectedIteration.id,
      },
    ];
  });

  return (
    <div className="view-stack">
      <svg className="chart-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Decision sankey">
        <text x={columns[0]} y="28" textAnchor="middle" className="chart-lane-label">
          Attitude
        </text>
        <text x={columns[1]} y="28" textAnchor="middle" className="chart-lane-label">
          Result
        </text>
        <text x={columns[2]} y="28" textAnchor="middle" className="chart-lane-label">
          Next movement
        </text>

        {flows.map((flow, index) => {
          const controlX = (flow.fromX + flow.toX) / 2;
          return (
            <path
              key={index}
              d={`M ${flow.fromX} ${flow.fromY} C ${controlX} ${flow.fromY}, ${controlX} ${flow.toY}, ${flow.toX} ${flow.toY}`}
              className={`sankey-flow ${flow.highlight ? "sankey-flow-highlight" : ""}`}
            />
          );
        })}

        {moveLabels.map((label) => (
          <g key={label}>
            <rect x={columns[0] - 88} y={(movePositions.get(label) ?? 70) - 20} width="176" height="40" rx="14" className="sankey-node" />
            <text x={columns[0]} y={(movePositions.get(label) ?? 70) + 5} textAnchor="middle" className="sankey-label">
              {label}
            </text>
          </g>
        ))}

        {outcomeLabels.map((label) => (
          <g key={label}>
            <rect x={columns[1] - 88} y={(outcomePositions.get(label) ?? 70) - 20} width="176" height="40" rx="14" className="sankey-node" />
            <text x={columns[1]} y={(outcomePositions.get(label) ?? 70) + 5} textAnchor="middle" className="sankey-label">
              {label}
            </text>
          </g>
        ))}

        {nextLabels.map((label) => (
          <g key={label}>
            <rect x={columns[2] - 88} y={(nextPositions.get(label) ?? 70) - 20} width="176" height="40" rx="14" className="sankey-node" />
            <text x={columns[2]} y={(nextPositions.get(label) ?? 70) + 5} textAnchor="middle" className="sankey-label">
              {label}
            </text>
          </g>
        ))}
      </svg>

      <div className="selected-summary-card">
        <h3>Selected flow: moment {selectedIteration.label}</h3>
        <p>
          {titleCase(selectedIteration.moveType, "Attitude")} →{" "}
          {titleCase(selectedIteration.outcome ?? selectedIteration.keepDiscardStatus, "Observed")} →{" "}
          {titleCase(selectedIteration.nextMoveType ?? selectedIteration.keepDiscardStatus, "Hold")}
        </p>
      </div>
    </div>
  );
}

function ExperimentGenomeView({
  iterations,
  selectedIteration,
  onSelectIteration,
}: {
  iterations: IterationNode[];
  selectedIteration: IterationNode;
  onSelectIteration: (iterationId: string) => void;
}) {
  const bestVal = Math.min(
    ...iterations.map((iteration) => iteration.metrics.valBpb ?? Number.POSITIVE_INFINITY),
  );
  const worstVal = Math.max(
    ...iterations.map((iteration) => iteration.metrics.valBpb ?? Number.NEGATIVE_INFINITY),
  );
  const maxVram = Math.max(...iterations.map((iteration) => iteration.metrics.peakVramMb ?? 0), 1);

  return (
    <div className="genome-grid">
      {iterations.map((iteration) => {
        const valRatio =
          iteration.metrics.valBpb !== null && Number.isFinite(bestVal) && Number.isFinite(worstVal)
            ? 1 - (iteration.metrics.valBpb - bestVal) / Math.max(worstVal - bestVal, 0.001)
            : 0.4;
        const vramRatio = (iteration.metrics.peakVramMb ?? 0) / maxVram;
        const tensionCount = iteration.activeTensionIds.length;
        return (
          <button
            key={iteration.id}
            className={`genome-card ${iteration.id === selectedIteration.id ? "genome-card-active" : ""}`}
            onClick={() => onSelectIteration(iteration.id)}
            type="button"
          >
            <svg viewBox="0 0 180 180" className="genome-svg" role="img" aria-label={`Archetype genome ${iteration.label}`}>
              <circle cx="90" cy="90" r="58" className="genome-ring" />
              <circle
                cx="90"
                cy="90"
                r={24 + valRatio * 26}
                className={`genome-core ${outcomeTone(iteration.keepDiscardStatus ?? iteration.outcome)}`}
              />
              <circle
                cx="90"
                cy="90"
                r={68}
                strokeDasharray={`${(140 + vramRatio * 180).toFixed(1)} 999`}
                className="genome-vram-ring"
              />
              {Array.from({ length: Math.min(8, Math.max(tensionCount, 1)) }).map((_, index) => {
                const angle = (index / Math.min(8, Math.max(tensionCount, 1))) * Math.PI * 2;
                return (
                  <circle
                    key={index}
                    cx={90 + Math.cos(angle) * 78}
                    cy={90 + Math.sin(angle) * 78}
                    r="4"
                    className="genome-dot"
                  />
                );
              })}
              <text x="90" y="88" textAnchor="middle" className="genome-label">
                {iteration.label}
              </text>
              <text x="90" y="108" textAnchor="middle" className="genome-value">
                {formatMetric(iteration.metrics.valBpb, 4)}
              </text>
            </svg>
            <div className="genome-copy">
              <strong>{titleCase(iteration.moveType, "Attitude")}</strong>
              <span>{tensionCount} complexes • {formatMemoryGb(iteration.metrics.peakVramMb)}</span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function NarrativeFilmstripView({
  iterations,
  selectedIteration,
  onSelectIteration,
}: {
  iterations: IterationNode[];
  selectedIteration: IterationNode;
  onSelectIteration: (iterationId: string) => void;
}) {
  return (
    <div className="filmstrip-row">
      {iterations.map((iteration) => (
        <button
          key={iteration.id}
          className={`film-card ${iteration.id === selectedIteration.id ? "film-card-active" : ""}`}
          onClick={() => onSelectIteration(iteration.id)}
          type="button"
        >
          <div className="film-card-top">
            <span className="badge badge-outline">{iteration.label}</span>
            <span className={`badge ${outcomeTone(iteration.keepDiscardStatus ?? iteration.outcome)}`}>
              {titleCase(iteration.outcome ?? iteration.keepDiscardStatus, "Observed")}
            </span>
          </div>
          <p className="eyebrow">Foretelling</p>
          <p>{truncateText(iteration.prediction, 92)}</p>
          <p className="eyebrow">Actualized</p>
          <p>{truncateText(iteration.summaryText ?? iteration.outcome, 92)}</p>
          <p className="eyebrow">Dissonance</p>
          <p>{truncateText(iteration.contradictedAssumption, 92)}</p>
          <p className="eyebrow">Next movement</p>
          <p>{titleCase(iteration.nextMoveType ?? iteration.moveType, "Attitude")}</p>
        </button>
      ))}
    </div>
  );
}

function InspectorPanel({
  session,
  iteration,
  selectedTension,
  tab,
}: {
  session: SessionGraph;
  iteration: IterationNode;
  selectedTension: TensionNode | null;
  tab: InspectorTab;
}) {
  if (tab === "metrics") {
    return (
      <div className="inspector-content">
        <div className="note-grid inspector-metric-grid">
          <MetricDatum label="Signal" value={formatMetric(iteration.metrics.valBpb, 6)} />
          <MetricDatum label="VRAM" value={formatMemoryGb(iteration.metrics.peakVramMb)} />
          <MetricDatum label="Training" value={formatDuration(iteration.metrics.trainingSeconds)} />
          <MetricDatum label="Total trace" value={formatDuration(iteration.metrics.totalSeconds)} />
          <MetricDatum label="MFU" value={formatPercent(iteration.metrics.mfuPercent)} />
          <MetricDatum label="Tokens" value={iteration.metrics.totalTokensM !== null ? `${formatCompactNumber(iteration.metrics.totalTokensM)}M` : "n/a"} />
          <MetricDatum label="Params" value={iteration.metrics.numParamsM !== null ? `${formatCompactNumber(iteration.metrics.numParamsM)}M` : "n/a"} />
          <MetricDatum label="Depth" value={iteration.metrics.depth !== null ? String(iteration.metrics.depth) : "n/a"} />
        </div>
        <LiveGpuPanel session={session} iteration={iteration} />
        <dl className="detail-list">
          <div>
            <dt>Attitude</dt>
            <dd>{titleCase(iteration.moveType, "Attitude")}</dd>
          </div>
          <div>
            <dt>Observed result</dt>
            <dd>{titleCase(iteration.outcome ?? iteration.keepDiscardStatus, "Observed")}</dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd>{formatDateTime(iteration.createdAt)}</dd>
          </div>
          <div>
            <dt>Completed</dt>
            <dd>{formatDateTime(iteration.completedAt)}</dd>
          </div>
          <div>
            <dt>Artifact path</dt>
            <dd>{iteration.sourcePath}</dd>
          </div>
          <div>
            <dt>Session telos</dt>
            <dd>{session.objective ?? "n/a"}</dd>
          </div>
        </dl>
      </div>
    );
  }

  if (tab === "plan") {
    return (
      <div className="inspector-content">
        <NarrativeCard title="Foretelling" body={iteration.prediction} tone="accent-thesis" />
        <CodexPhasePanel phaseArtifact={iteration.preparePhase} title="Prepare modifications" />
        <dl className="detail-list">
          <div>
            <dt>Parent commit</dt>
            <dd>{valueOrFallback(iteration.parentCommit)}</dd>
          </div>
          <div>
            <dt>Candidate commit</dt>
            <dd>{valueOrFallback(iteration.candidateCommit)}</dd>
          </div>
          <div>
            <dt>Active complexes</dt>
            <dd>{iteration.activeTensionIds.length ? iteration.activeTensionIds.join(", ") : "None constellated"}</dd>
          </div>
        </dl>
        <JsonPanel title="plan.json" payload={iteration.planRaw} />
      </div>
    );
  }

  if (tab === "result") {
    const reflection = liveReflectionForIteration(session, iteration);
    return (
      <div className="inspector-content">
        <NarrativeCard title="Integration" body={iteration.summaryText ?? iteration.outcome} tone="accent-neutral" />
        {reflection ? <LiveReflectionPanel reflection={reflection} /> : null}
        <CodexPhasePanel phaseArtifact={iteration.reflectPhase} title="Reflect modifications" />
        <dl className="detail-list">
          <div>
            <dt>Observed result</dt>
            <dd>{titleCase(iteration.outcome, "Observed")}</dd>
          </div>
          <div>
            <dt>Integration status</dt>
            <dd>{titleCase(iteration.keepDiscardStatus, "Not set")}</dd>
          </div>
          <div>
            <dt>Wounded assumption</dt>
            <dd>{valueOrFallback(iteration.contradictedAssumption)}</dd>
          </div>
          <div>
            <dt>Next movement</dt>
            <dd>{titleCase(iteration.nextMoveType, "Not set")}</dd>
          </div>
        </dl>
        <JsonPanel title="result.json" payload={iteration.resultRaw} />
      </div>
    );
  }

  if (tab === "code") {
    return (
      <div className="inspector-content">
        <CodePanel title="Embodied train.py" snapshot={iteration.actualCode} />
      </div>
    );
  }

  if (tab === "diff") {
    return (
      <div className="inspector-content">
        <CodePanel title="Mutation patch" snapshot={iteration.diff} />
      </div>
    );
  }

  if (tab === "tensions") {
    return (
      <div className="inspector-content">
        {iteration.tensions.length ? (
          <>
            {iteration.tensions.map((tension) => (
              <article key={tension.id} className={`tension-card ${selectedTension?.id === tension.id ? "tension-card-active" : ""}`}>
                <div className="tension-card-top">
                  <div>
                    <p className="eyebrow">Complex</p>
                    <h3>{tension.label}</h3>
                  </div>
                  <span className="badge badge-outline">{tension.id}</span>
                </div>
                <p>{valueOrFallback(tension.whyActive)}</p>
                <dl className="detail-list compact-detail-list">
                  <div>
                    <dt>Kind</dt>
                    <dd>{valueOrFallback(tension.kind)}</dd>
                  </div>
                  <div>
                    <dt>Dominant side</dt>
                    <dd>{valueOrFallback(tension.favoredSide)}</dd>
                  </div>
                </dl>
              </article>
            ))}
          </>
        ) : (
          <div className="empty-state">
            <p>No structured complexes were captured for this moment.</p>
          </div>
        )}
      </div>
    );
  }

  if (tab === "transcendent") {
    return (
      <div className="inspector-content">
        {iteration.transcendent ? (
          <>
            <NarrativeCard title="Emergent image" body={iteration.transcendent.emergentThought} tone="accent-synthesis" />
            <dl className="detail-list">
              <div>
                <dt>Source complexes</dt>
                <dd>{iteration.transcendent.sourceTensionIds.join(", ") || "None constellated"}</dd>
              </div>
              <div>
                <dt>Embodied change</dt>
                <dd>{valueOrFallback(iteration.transcendent.concreteChange)}</dd>
              </div>
              <div>
                <dt>Transcendent status</dt>
                <dd>{titleCase(iteration.transcendent.resultStatus, "Observed")}</dd>
              </div>
            </dl>
            <CodePanel title="Synthesized code" snapshot={iteration.transcendent.code} />
            <JsonPanel title="transcendent/result.json" payload={iteration.transcendent.raw} />
          </>
        ) : (
          <div className="empty-state">
            <p>No transcendent artifact was captured for this moment.</p>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="inspector-content">
      <JsonPanel title="Trace summary" payload={iteration.execution.summary} />
      <JsonPanel title="Trace metadata" payload={iteration.execution.metadata} />
      <JsonPanel title="Relay state" payload={iteration.execution.relayState} />
      <CodePanel title="Structured live telemetry" snapshot={iteration.execution.liveEvents} compact />
      <CodePanel title="run.log" snapshot={iteration.execution.runLog} />
    </div>
  );
}

function NarrativeCard({
  title,
  body,
  tone,
}: {
  title: string;
  body: string | null | undefined;
  tone: string;
}) {
  return (
    <article className={`narrative-card ${tone}`}>
      <p className="eyebrow">{title}</p>
      <p>{valueOrFallback(body)}</p>
    </article>
  );
}

function MetricDatum({ label, value }: { label: string; value: string }) {
  return (
    <div className="datum-card">
      <span className="metric-label">{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function CodexPhasePanel({
  phaseArtifact,
  title,
}: {
  phaseArtifact: CodexPhaseArtifact | null;
  title: string;
}) {
  if (!phaseArtifact) {
    return null;
  }

  return (
    <section className="panel-block">
      <div className="panel-block-top">
        <h3>{title}</h3>
        <span className="badge badge-outline">{titleCase(phaseArtifact.phase)}</span>
      </div>
      <p className="muted">{valueOrFallback(phaseArtifact.summary, "No Codex summary captured.")}</p>
      <dl className="detail-list compact-detail-list">
        <div>
          <dt>Modified files</dt>
          <dd>{phaseArtifact.modifiedFiles.length ? phaseArtifact.modifiedFiles.join(", ") : "No file changes captured"}</dd>
        </div>
        <div>
          <dt>Patch count</dt>
          <dd>{String(phaseArtifact.patches.length)}</dd>
        </div>
      </dl>
      <CompactPatchViewer phaseArtifact={phaseArtifact} />
      {phaseArtifact.lastMessage ? (
        <details className="patch-drawer">
          <summary className="patch-summary">
            <span className="patch-summary-copy">
              <strong>Codex last message</strong>
              <span>Phase narration</span>
            </span>
          </summary>
          <pre className="code-frame code-frame-compact">
            <code>{phaseArtifact.lastMessage.content ?? "No Codex summary captured."}</code>
          </pre>
        </details>
      ) : null}
      {phaseArtifact.stateSnapshot ? (
        <details className="patch-drawer">
          <summary className="patch-summary">
            <span className="patch-summary-copy">
              <strong>Staged iteration state</strong>
              <span>{phaseArtifact.stateSnapshot.path ?? "current_iteration.json"}</span>
            </span>
          </summary>
          <pre className="code-frame code-frame-compact">
            <code>{phaseArtifact.stateSnapshot.content ?? "No iteration state captured."}</code>
          </pre>
        </details>
      ) : null}
    </section>
  );
}

function JsonPanel({ title, payload }: { title: string; payload: Record<string, unknown> | null }) {
  return (
    <section className="panel-block">
      <div className="panel-block-top">
        <h3>{title}</h3>
      </div>
      <pre className="code-frame json-frame">
        <code>{payload ? JSON.stringify(payload, null, 2) : "No JSON payload captured."}</code>
      </pre>
    </section>
  );
}

function CodePanel({
  title,
  snapshot,
  compact = false,
}: {
  title: string;
  snapshot: CodeSnapshot | null;
  compact?: boolean;
}) {
  return (
    <section className="panel-block">
      <div className="panel-block-top">
        <h3>{title}</h3>
        {snapshot?.path ? <span className="muted">{snapshot.path}</span> : null}
      </div>
      <pre className={`code-frame ${compact ? "code-frame-compact" : ""}`}>
        <code>{snapshot?.content ?? "No code artifact captured."}</code>
      </pre>
    </section>
  );
}
