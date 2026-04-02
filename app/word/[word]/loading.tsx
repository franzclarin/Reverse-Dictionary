export default function WordPageLoading() {
  return (
    <>
      <div className="loading-overlay">
        <div className="loading-content">
          <div className="loading-symbol">◈</div>
          <div className="loading-dots">
            <span>Generating</span>
            <span className="dot">.</span>
            <span className="dot">.</span>
            <span className="dot">.</span>
          </div>
          <p className="loading-subtext">Building word profile</p>
        </div>
      </div>

      <main className="max-w-3xl mx-auto px-6 py-12">
        <div className="mb-8">
          <div className="skeleton skeleton-word-heading" />
          <div className="skeleton skeleton-badge" />
        </div>
        <div className="skeleton skeleton-divider" />
        <div className="skeleton skeleton-definition" style={{ marginTop: "2.5rem" }} />
        <div className="skeleton skeleton-definition short" />
        <div className="skeleton skeleton-divider" />
        <div className="skeleton skeleton-label" style={{ marginTop: "2.5rem" }} />
        <div className="skeleton skeleton-etymology" />
      </main>
    </>
  );
}
