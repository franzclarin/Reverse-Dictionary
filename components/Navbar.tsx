import Link from "next/link";

export default function Navbar() {
  return (
    <header style={{ borderBottom: "1px solid var(--rd-border)", background: "var(--rd-paper)" }}>
      <nav className="max-w-6xl mx-auto px-6 h-16 flex items-center">
        {/* Logo mark */}
        <Link
          href="/"
          className="flex items-center gap-2 rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
          style={{ outlineColor: "var(--rd-accent)" }}
        >
          <span
            className="font-serif text-xl leading-none"
            style={{ color: "var(--rd-accent)" }}
            aria-hidden="true"
          >
            ¶
          </span>
          <span
            className="font-serif text-xl leading-none"
            style={{ color: "var(--rd-ink)" }}
          >
            Reverse Dictionary
          </span>
        </Link>
      </nav>
    </header>
  );
}
