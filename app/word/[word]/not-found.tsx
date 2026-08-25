import Link from "next/link";

export default function WordNotFound() {
  return (
    <main
      className="min-h-screen flex flex-col items-center justify-center px-6 text-center"
      style={{ background: "var(--rd-paper)" }}
    >
      <p
        className="font-serif mb-2"
        style={{ fontSize: "22px", color: "var(--rd-ink)" }}
      >
        Word not found
      </p>
      <p className="font-sans mb-6" style={{ fontSize: "14px", color: "var(--rd-ink-muted)" }}>
        This word isn&apos;t in the model&apos;s vocabulary.
      </p>
      <Link
        href="/"
        className="font-mono text-xs uppercase tracking-wide hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
        style={{ color: "var(--rd-accent)", outlineColor: "var(--rd-accent)" }}
      >
        New search →
      </Link>
    </main>
  );
}
