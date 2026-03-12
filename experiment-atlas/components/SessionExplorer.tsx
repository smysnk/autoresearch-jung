"use client";

import Link from "next/link";
import { startTransition, useDeferredValue, useState } from "react";

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
import type { CodeSnapshot, IterationNode, SessionGraph, TensionNode, TranscendentArtifact, VisualMode } from "@/lib/types";

type SessionExplorerProps = {
  session: SessionGraph;
  initialIterationLabel?: string;
  initialMode?: VisualMode;
  focusTensionId?: string;
};

type InspectorTab = "metrics" | "plan" | "result" | "code" | "diff" | "tensions" | "transcendent" | "execution";

const VIEW_OPTIONS: { id: VisualMode; label: string; description: string }[] = [
  { id: "chronicle", label: "Chronicle", description: "Metric timeline and iteration narrative" },
  { id: "braid", label: "Dialectic Braid", description: "Thesis / antithesis / synthesis movement" },
  { id: "mirror", label: "Counterfactual Mirror", description: "Compare thesis, synthesis, and antithesis" },
  { id: "constellation", label: "Tension Constellation", description: "Session tensions as a network around the selected run" },
  { id: "stratigraphy", label: "Code Stratigraphy", description: "Code churn and outcomes as layered sediment" },
  { id: "sankey", label: "Decision Sankey", description: "How moves flow into outcomes and next moves" },
  { id: "genome", label: "Experiment Genome", description: "Dense glyph comparison across all iterations" },
  { id: "filmstrip", label: "Narrative Filmstrip", description: "A compact storyboard of prediction, result, and contradiction" },
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

function summarizeExecution(iteration: IterationNode): string {
  const parts = [
    iteration.metrics.valBpb !== null ? `val_bpb ${formatMetric(iteration.metrics.valBpb, 6)}` : null,
    iteration.metrics.peakVramMb !== null ? formatMemoryGb(iteration.metrics.peakVramMb) : null,
    iteration.metrics.totalTokensM !== null ? `${formatCompactNumber(iteration.metrics.totalTokensM)}M tokens` : null,
  ].filter((part): part is string => Boolean(part));

  return parts.join(" • ") || "No execution metrics captured yet.";
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

function valueOrFallback(value: string | null | undefined, fallback = "Not captured"): string {
  return value ?? fallback;
}

export function SessionExplorer({
  session,
  initialIterationLabel,
  initialMode = "chronicle",
  focusTensionId,
}: SessionExplorerProps) {
  const normalizedInitialIteration = normalizeIterationLabel(initialIterationLabel);
  const initialIteration =
    session.iterations.find(
      (iteration) =>
        iteration.label === normalizedInitialIteration || String(iteration.iteration) === initialIterationLabel,
    ) ?? session.iterations[0];
  const [selectedIterationId, setSelectedIterationId] = useState(initialIteration?.id ?? "");
  const [activeMode, setActiveMode] = useState<VisualMode>(initialMode);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("metrics");
  const [selectedTensionId, setSelectedTensionId] = useState(
    focusTensionId ?? initialIteration?.tensions[0]?.id ?? session.tensions[0]?.id ?? "",
  );
  const deferredIterationId = useDeferredValue(selectedIterationId);
  const selectedIteration =
    session.iterations.find((iteration) => iteration.id === deferredIterationId) ?? initialIteration ?? null;

  if (!selectedIteration) {
    return (
      <main className="page-shell compact-shell">
        <section className="hero-panel">
          <p className="eyebrow">Experiment Atlas</p>
          <h1>{session.title}</h1>
          <p className="lead">This session exists, but no iterations were readable.</p>
          <Link className="button-link" href="/">
            Return to gallery
          </Link>
        </section>
      </main>
    );
  }

  const selectedTension = getSelectedTension(session, selectedIteration, selectedTensionId);
  const mirror = getMirrorArtifact(session, selectedIteration, selectedTension);

  return (
    <main className="page-shell explorer-shell">
      <section className="hero-panel hero-panel-tight">
        <div className="hero-copy">
          <p className="eyebrow">Experiment Atlas</p>
          <h1>{session.title}</h1>
          <p className="lead">
            {session.branch} • {titleCase(session.runnerMode)} • {session.source === "runpod" ? "fallback adapter" : "canonical log"}
          </p>
          <p className="session-summary-text">
            {session.source === "runpod"
              ? "This session is assembled from runpod artifacts, so only metrics and logs are guaranteed."
              : truncateText(session.notes, 160)}
          </p>
        </div>

        <div className="hero-actions">
          <Link className="button-link" href="/">
            All sessions
          </Link>
          <Link className="button-link button-link-subtle" href={`/session/${session.id}/iteration/${selectedIteration.label}`}>
            Selected iteration
          </Link>
          <Link
            className="button-link button-link-subtle"
            href={`/session/${session.id}/compare${selectedTension ? `?tension=${encodeQueryValue(selectedTension.id)}` : ""}`}
          >
            Mirror view
          </Link>
        </div>

        <div className="hero-metrics hero-metrics-wide">
          <StatCard label="Iterations" value={String(session.stats.iterationCount)} detail={formatDateTime(session.updatedAt)} tone="accent-thesis" />
          <StatCard
            label="Best val_bpb"
            value={formatMetric(session.stats.bestValBpb, 6)}
            detail={session.stats.bestValBpb === null ? "Awaiting metrics" : "Lower is better"}
            tone="accent-synthesis"
          />
          <StatCard
            label="Active tensions"
            value={String(session.stats.activeTensionCount)}
            detail={`${session.stats.confirmedCount} confirmed, ${session.stats.contradictionCount} contradicted`}
            tone="accent-antithesis"
          />
          <StatCard
            label="Selected run"
            value={selectedIteration.label}
            detail={summarizeExecution(selectedIteration)}
            tone="accent-neutral"
          />
        </div>
      </section>

      <section className="explorer-layout">
        <aside className="panel iteration-rail">
          <div className="rail-heading">
            <div>
              <p className="eyebrow">Iterations</p>
              <h2>Session path</h2>
            </div>
            <span className="badge badge-outline">{session.stats.iterationCount}</span>
          </div>

          <div className="rail-list">
            {session.iterations.map((iteration) => {
              const isActive = iteration.id === selectedIteration.id;

              return (
                <button
                  key={iteration.id}
                  className={`rail-item ${isActive ? "rail-item-active" : ""}`}
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
                    <strong>{titleCase(iteration.moveType, "Observe")}</strong>
                    <p>{truncateText(iteration.prediction ?? iteration.summaryText, 72)}</p>
                  </div>
                  <div className="rail-item-meta">
                    <span>{formatMetric(iteration.metrics.valBpb, 6)}</span>
                    <span>{formatMemoryGb(iteration.metrics.peakVramMb)}</span>
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
                <p className="eyebrow">Visual Canvas</p>
                <h2>{VIEW_OPTIONS.find((view) => view.id === activeMode)?.label}</h2>
                <p>{VIEW_OPTIONS.find((view) => view.id === activeMode)?.description}</p>
              </div>

              <div className="view-toolbar-actions">
                {VIEW_OPTIONS.map((view) => (
                  <button
                    key={view.id}
                    className={`toolbar-chip ${activeMode === view.id ? "toolbar-chip-active" : ""}`}
                    onClick={() => startTransition(() => setActiveMode(view.id))}
                    type="button"
                  >
                    {view.label}
                  </button>
                ))}
              </div>
            </div>

            {activeMode === "chronicle" ? (
              <ChronicleView
                iterations={session.iterations}
                selectedIteration={selectedIteration}
                onSelectIteration={(iterationId) => startTransition(() => setSelectedIterationId(iterationId))}
              />
            ) : null}

            {activeMode === "braid" ? (
              <DialecticBraidView
                iterations={session.iterations}
                selectedIteration={selectedIteration}
                onSelectIteration={(iterationId) => startTransition(() => setSelectedIterationId(iterationId))}
              />
            ) : null}

            {activeMode === "mirror" ? (
              <CounterfactualMirrorView
                session={session}
                selectedIteration={selectedIteration}
                selectedTension={selectedTension}
                selectedTensionId={selectedTensionId}
                mirror={mirror}
                onSelectTension={(tensionId) => startTransition(() => setSelectedTensionId(tensionId))}
              />
            ) : null}

            {activeMode === "constellation" ? (
              <TensionConstellationView
                session={session}
                selectedIteration={selectedIteration}
                selectedTension={selectedTension}
                onSelectTension={(tensionId) => startTransition(() => setSelectedTensionId(tensionId))}
              />
            ) : null}

            {activeMode === "stratigraphy" ? (
              <CodeStratigraphyView
                iterations={session.iterations}
                selectedIteration={selectedIteration}
                onSelectIteration={(iterationId) => startTransition(() => setSelectedIterationId(iterationId))}
              />
            ) : null}

            {activeMode === "sankey" ? (
              <DecisionSankeyView iterations={session.iterations} selectedIteration={selectedIteration} />
            ) : null}

            {activeMode === "genome" ? (
              <ExperimentGenomeView
                iterations={session.iterations}
                selectedIteration={selectedIteration}
                onSelectIteration={(iterationId) => startTransition(() => setSelectedIterationId(iterationId))}
              />
            ) : null}

            {activeMode === "filmstrip" ? (
              <NarrativeFilmstripView
                iterations={session.iterations}
                selectedIteration={selectedIteration}
                onSelectIteration={(iterationId) => startTransition(() => setSelectedIterationId(iterationId))}
              />
            ) : null}
          </div>
        </section>

        <aside className="panel inspector-card">
          <div className="inspector-heading">
            <div>
              <p className="eyebrow">Inspector</p>
              <h2>Iteration {selectedIteration.label}</h2>
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
                onClick={() => startTransition(() => setInspectorTab(tab))}
                type="button"
              >
                {titleCase(tab)}
              </button>
            ))}
          </div>

          <InspectorPanel
            session={session}
            iteration={selectedIteration}
            selectedTension={selectedTension}
            tab={inspectorTab}
          />
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
                  {index === tickValues.length - 1 ? "Earlier worse" : "Midline"}
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
        <NarrativeCard title="Prediction" body={selectedIteration.prediction} tone="accent-thesis" />
        <NarrativeCard title="Outcome" body={selectedIteration.outcome ?? selectedIteration.status} tone="accent-neutral" />
        <NarrativeCard
          title="Contradiction"
          body={selectedIteration.contradictedAssumption ?? selectedIteration.summaryText}
          tone="accent-antithesis"
        />
        <NarrativeCard title="Next Move" body={selectedIteration.nextMoveType ?? selectedIteration.moveType} tone="accent-synthesis" />
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
      <svg className="chart-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Dialectic braid view">
        <path d={`M ${paddingX} ${lanes.thesis} C 280 ${lanes.thesis - 16}, 700 ${lanes.thesis + 16}, ${width - paddingX} ${lanes.thesis}`} className="lane-path thesis-lane" />
        <path d={`M ${paddingX} ${lanes.synthesis} C 300 ${lanes.synthesis - 12}, 680 ${lanes.synthesis + 12}, ${width - paddingX} ${lanes.synthesis}`} className="lane-path synthesis-lane" />
        <path d={`M ${paddingX} ${lanes.antithesis} C 280 ${lanes.antithesis - 16}, 700 ${lanes.antithesis + 16}, ${width - paddingX} ${lanes.antithesis}`} className="lane-path antithesis-lane" />

        <text x={paddingX} y={lanes.thesis - 26} className="chart-lane-label">
          Thesis / exploit
        </text>
        <text x={paddingX} y={lanes.synthesis - 26} className="chart-lane-label">
          Synthesis / merge
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
          <span className="legend-chip legend-chip-synthesis">Synthesis</span>
          <span className="legend-chip legend-chip-antithesis">Antithesis</span>
        </div>
        <p className="muted">
          The thread shows how the session moved between exploitation, direct negation, and synthesis. Each knot is
          color-coded by outcome and keeps the iteration ordering intact.
        </p>
        <div className="selected-summary-card">
          <h3>Iteration {selectedIteration.label}</h3>
          <p>{truncateText(selectedIteration.prediction ?? selectedIteration.summaryText, 140)}</p>
          <dl className="inline-stats">
            <div>
              <dt>Move</dt>
              <dd>{titleCase(selectedIteration.moveType, "Observe")}</dd>
            </div>
            <div>
              <dt>Outcome</dt>
              <dd>{titleCase(selectedIteration.outcome ?? selectedIteration.keepDiscardStatus, "Observed")}</dd>
            </div>
            <div>
              <dt>Val BPB</dt>
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
          <p>No structured tensions have been captured for this session yet.</p>
          <p className="muted">
            The mirror view will become richer once canonical logs include thesis and antithesis snapshots under
            <code>tensions/*</code>.
          </p>
        </div>
        <CodePanel title="Current tested code" snapshot={selectedIteration.actualCode} compact />
      </div>
    );
  }

  return (
    <div className="view-stack">
      <div className="mirror-toolbar">
        <label className="field-label" htmlFor="tension-select">
          Focus tension
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
          subtitle={selectedTension?.label ?? "Current favored side"}
          tone="mirror-thesis"
          summary={selectedTension?.whyActive}
          code={selectedTension?.thesis}
        />

        <MirrorColumn
          title="Synthesis"
          subtitle={`Iteration ${mirror.iteration.label}`}
          tone="mirror-synthesis"
          summary={mirror.artifact?.emergentThought ?? mirror.iteration.summaryText ?? mirror.iteration.prediction}
          code={mirror.artifact?.code ?? mirror.iteration.actualCode}
          footer={`Status: ${titleCase(mirror.artifact?.resultStatus ?? mirror.iteration.outcome, "Observed")}`}
        />

        <MirrorColumn
          title="Antithesis"
          subtitle={selectedTension?.kind ?? "Competing pole"}
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
        <p>No structured tension graph is available for this session yet.</p>
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
      <svg className="chart-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Tension constellation">
        <circle cx={centerX} cy={centerY} r="80" className="constellation-core" />
        <text x={centerX} y={centerY - 6} textAnchor="middle" className="constellation-core-label">
          Iteration {selectedIteration.label}
        </text>
        <text x={centerX} y={centerY + 18} textAnchor="middle" className="chart-axis-label">
          {titleCase(selectedIteration.moveType, "Observe")}
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
        <NarrativeCard title="Focused tension" body={selectedTension?.label} tone="accent-thesis" />
        <NarrativeCard title="Why active" body={selectedTension?.whyActive} tone="accent-neutral" />
        <NarrativeCard
          title="Favored side"
          body={selectedTension?.favoredSide ? `Favored: ${selectedTension.favoredSide}` : selectedTension?.kind}
          tone="accent-antithesis"
        />
        <NarrativeCard
          title="Reuse"
          body={
            selectedTension
              ? `Appears in ${selectedTension.iterationRefs.length} iteration${selectedTension.iterationRefs.length === 1 ? "" : "s"}`
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
              <h3>{titleCase(iteration.moveType, "Observe")}</h3>
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
          Move type
        </text>
        <text x={columns[1]} y="28" textAnchor="middle" className="chart-lane-label">
          Outcome
        </text>
        <text x={columns[2]} y="28" textAnchor="middle" className="chart-lane-label">
          Next move
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
        <h3>Selected flow: iteration {selectedIteration.label}</h3>
        <p>
          {titleCase(selectedIteration.moveType, "Observe")} →{" "}
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
            <svg viewBox="0 0 180 180" className="genome-svg" role="img" aria-label={`Experiment genome ${iteration.label}`}>
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
              <strong>{titleCase(iteration.moveType, "Observe")}</strong>
              <span>{tensionCount} tensions • {formatMemoryGb(iteration.metrics.peakVramMb)}</span>
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
          <p className="eyebrow">Prediction</p>
          <p>{truncateText(iteration.prediction, 92)}</p>
          <p className="eyebrow">Actual</p>
          <p>{truncateText(iteration.summaryText ?? iteration.outcome, 92)}</p>
          <p className="eyebrow">Contradiction</p>
          <p>{truncateText(iteration.contradictedAssumption, 92)}</p>
          <p className="eyebrow">Next move</p>
          <p>{titleCase(iteration.nextMoveType ?? iteration.moveType, "Observe")}</p>
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
          <MetricDatum label="Val BPB" value={formatMetric(iteration.metrics.valBpb, 6)} />
          <MetricDatum label="VRAM" value={formatMemoryGb(iteration.metrics.peakVramMb)} />
          <MetricDatum label="Training" value={formatDuration(iteration.metrics.trainingSeconds)} />
          <MetricDatum label="Total" value={formatDuration(iteration.metrics.totalSeconds)} />
          <MetricDatum label="MFU" value={formatPercent(iteration.metrics.mfuPercent)} />
          <MetricDatum label="Tokens" value={iteration.metrics.totalTokensM !== null ? `${formatCompactNumber(iteration.metrics.totalTokensM)}M` : "n/a"} />
          <MetricDatum label="Params" value={iteration.metrics.numParamsM !== null ? `${formatCompactNumber(iteration.metrics.numParamsM)}M` : "n/a"} />
          <MetricDatum label="Depth" value={iteration.metrics.depth !== null ? String(iteration.metrics.depth) : "n/a"} />
        </div>
        <dl className="detail-list">
          <div>
            <dt>Move type</dt>
            <dd>{titleCase(iteration.moveType, "Observe")}</dd>
          </div>
          <div>
            <dt>Outcome</dt>
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
            <dt>Source</dt>
            <dd>{iteration.sourcePath}</dd>
          </div>
          <div>
            <dt>Session objective</dt>
            <dd>{session.objective ?? "n/a"}</dd>
          </div>
        </dl>
      </div>
    );
  }

  if (tab === "plan") {
    return (
      <div className="inspector-content">
        <NarrativeCard title="Prediction" body={iteration.prediction} tone="accent-thesis" />
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
            <dt>Active tensions</dt>
            <dd>{iteration.activeTensionIds.length ? iteration.activeTensionIds.join(", ") : "None captured"}</dd>
          </div>
        </dl>
        <JsonPanel title="plan.json" payload={iteration.planRaw} />
      </div>
    );
  }

  if (tab === "result") {
    return (
      <div className="inspector-content">
        <NarrativeCard title="Result" body={iteration.summaryText ?? iteration.outcome} tone="accent-neutral" />
        <dl className="detail-list">
          <div>
            <dt>Outcome</dt>
            <dd>{titleCase(iteration.outcome, "Observed")}</dd>
          </div>
          <div>
            <dt>Keep / discard</dt>
            <dd>{titleCase(iteration.keepDiscardStatus, "Not set")}</dd>
          </div>
          <div>
            <dt>Contradicted assumption</dt>
            <dd>{valueOrFallback(iteration.contradictedAssumption)}</dd>
          </div>
          <div>
            <dt>Next move</dt>
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
        <CodePanel title="Tested train.py" snapshot={iteration.actualCode} />
      </div>
    );
  }

  if (tab === "diff") {
    return (
      <div className="inspector-content">
        <CodePanel title="train.py diff" snapshot={iteration.diff} />
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
                    <p className="eyebrow">Tension</p>
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
                    <dt>Favored side</dt>
                    <dd>{valueOrFallback(tension.favoredSide)}</dd>
                  </div>
                </dl>
              </article>
            ))}
          </>
        ) : (
          <div className="empty-state">
            <p>No structured tensions captured for this iteration.</p>
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
            <NarrativeCard title="Emergent thought" body={iteration.transcendent.emergentThought} tone="accent-synthesis" />
            <dl className="detail-list">
              <div>
                <dt>Source tensions</dt>
                <dd>{iteration.transcendent.sourceTensionIds.join(", ") || "None captured"}</dd>
              </div>
              <div>
                <dt>Concrete change</dt>
                <dd>{valueOrFallback(iteration.transcendent.concreteChange)}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>{titleCase(iteration.transcendent.resultStatus, "Observed")}</dd>
              </div>
            </dl>
            <CodePanel title="Synthesis code" snapshot={iteration.transcendent.code} />
            <JsonPanel title="transcendent/result.json" payload={iteration.transcendent.raw} />
          </>
        ) : (
          <div className="empty-state">
            <p>No transcendent artifact was captured for this iteration.</p>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="inspector-content">
      <JsonPanel title="Execution summary" payload={iteration.execution.summary} />
      <JsonPanel title="Execution metadata" payload={iteration.execution.metadata} />
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
