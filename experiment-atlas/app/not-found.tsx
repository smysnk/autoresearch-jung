import Link from "next/link";

export default function NotFoundPage() {
  return (
    <main className="page-shell compact-shell">
      <section className="hero-panel">
        <p className="eyebrow">Experiment Atlas</p>
        <h1>Session not found</h1>
        <p className="lead">
          The requested session could not be loaded from <code>experiment_logs/</code> or the fallback
          <code>runpod_runs/</code> adapter.
        </p>
        <Link className="button-link" href="/">
          Return to session gallery
        </Link>
      </section>
    </main>
  );
}
