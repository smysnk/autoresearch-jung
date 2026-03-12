import Link from "next/link";

export default function NotFoundPage() {
  return (
    <main className="page-shell compact-shell">
      <section className="hero-panel">
        <p className="eyebrow">Experiment Atlas</p>
        <h1>Constellation not found</h1>
        <p className="lead">
          The requested constellation could not be loaded from <code>experiment_logs/</code> or the fallback
          <code>runpod_runs/</code> trace adapter.
        </p>
        <Link className="button-link" href="/">
          Return to the atlas
        </Link>
      </section>
    </main>
  );
}
