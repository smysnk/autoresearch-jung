import Link from "next/link";

import { formatDateTime, formatMemoryGb, formatMetric, titleCase, truncateText } from "@/lib/formatters";
import type { SessionGraph } from "@/lib/types";

type SessionGalleryProps = {
  sessions: SessionGraph[];
};

export function SessionGallery({ sessions }: SessionGalleryProps) {
  const canonicalCount = sessions.filter((session) => session.source === "experiment_logs").length;
  const fallbackCount = sessions.filter((session) => session.source === "runpod").length;

  return (
    <main className="page-shell">
      <section className="hero-panel">
        <div className="hero-copy">
          <p className="eyebrow">Experiment Atlas</p>
          <h1>Research constellations as a navigable map, not a flat run log.</h1>
          <p className="lead">
            This explorer reads canonical constellations from <code>experiment_logs/</code> and falls back to grouped
            <code>runpod_runs/</code> traces when the deeper symbolic schema is not available yet.
          </p>
        </div>
        <div className="hero-metrics">
          <div className="metric-card accent-thesis">
            <span className="metric-label">Constellations</span>
            <strong>{sessions.length}</strong>
            <span className="metric-detail">{canonicalCount} canonical psyches, {fallbackCount} shadow traces</span>
          </div>
          <div className="metric-card accent-synthesis">
            <span className="metric-label">Best Visible Signal</span>
            <strong>
              {formatMetric(
                [...sessions]
                  .map((session) => session.stats.bestValBpb)
                  .filter((value): value is number => value !== null)
                  .sort((left, right) => left - right)[0] ?? null,
                6,
              )}
            </strong>
            <span className="metric-detail">Across all currently readable constellations</span>
          </div>
        </div>
      </section>

      <section className="gallery-panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Constellation Gallery</p>
            <h2>Available research psyches</h2>
          </div>
        </div>

        {sessions.length === 0 ? (
          <div className="empty-state">
            <p>No experiment constellations were found.</p>
            <p className="muted">
              Add canonical logs under <code>experiment_logs/</code> or keep generating <code>runpod_runs/</code>
              artifacts for the fallback trace adapter.
            </p>
          </div>
        ) : (
          <div className="session-grid">
            {sessions.map((session) => (
              <Link key={session.id} href={`/session/${session.id}`} className="session-card">
                <div className="session-card-top">
                  <span className={`badge ${session.source === "experiment_logs" ? "badge-keep" : "badge-neutral"}`}>
                    {session.source === "experiment_logs" ? "Canonical" : "Shadow Trace"}
                  </span>
                  <span className="badge badge-outline">{titleCase(session.runnerMode)}</span>
                </div>

                <div className="session-card-copy">
                  <h3>{session.title}</h3>
                  <p className="session-branch">{session.branch}</p>
                  <p className="session-summary">{truncateText(session.notes, 110)}</p>
                </div>

                <dl className="session-stats">
                  <div>
                    <dt>Moments</dt>
                    <dd>{session.stats.iterationCount}</dd>
                  </div>
                  <div>
                    <dt>Best signal</dt>
                    <dd>{formatMetric(session.stats.bestValBpb, 6)}</dd>
                  </div>
                  <div>
                    <dt>Latest memory</dt>
                    <dd>
                      {formatMemoryGb(
                        [...session.iterations]
                          .reverse()
                          .map((iteration) => iteration.metrics.peakVramMb)
                          .find((value): value is number => value !== null) ?? null,
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Last constellated</dt>
                    <dd>{formatDateTime(session.updatedAt)}</dd>
                  </div>
                </dl>
              </Link>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
