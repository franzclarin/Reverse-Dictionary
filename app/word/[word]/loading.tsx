export default function WordPageLoading() {
  return (
    <main
      className="min-h-screen flex items-center justify-center"
      style={{ background: "var(--gs-bg)" }}
    >
      <div className="flex flex-col items-center gap-3.5">
        <div className="loading-spinner" aria-hidden="true" />
        <p className="font-google" style={{ fontSize: "13px", color: "var(--gs-text-muted)" }}>
          Loading word…
        </p>
      </div>
    </main>
  );
}
