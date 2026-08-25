export default function WordPageLoading() {
  return (
    <main
      className="min-h-screen flex items-center justify-center"
      style={{ background: "var(--rd-paper)" }}
    >
      <div className="flex flex-col items-center gap-3.5">
        <div className="loading-spinner" aria-hidden="true" />
        <p className="font-mono" style={{ fontSize: "12px", color: "var(--rd-ink-muted)" }}>
          Loading word…
        </p>
      </div>
    </main>
  );
}
