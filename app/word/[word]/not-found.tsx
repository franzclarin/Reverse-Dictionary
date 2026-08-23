import Link from "next/link";

export default function WordNotFound() {
  return (
    <main
      className="min-h-screen flex flex-col items-center justify-center px-6 text-center"
      style={{ background: "var(--gs-bg)" }}
    >
      <p
        className="font-google mb-2"
        style={{ fontSize: "20px", fontWeight: 500, color: "var(--gs-text-primary)" }}
      >
        Word not found
      </p>
      <p className="font-google mb-6" style={{ fontSize: "14px", color: "var(--gs-text-muted)" }}>
        This word isn&apos;t in the model&apos;s vocabulary.
      </p>
      <Link
        href="/"
        className="font-google text-sm hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
        style={{ color: "var(--gs-accent)", outlineColor: "var(--gs-accent)" }}
      >
        New search →
      </Link>
    </main>
  );
}
