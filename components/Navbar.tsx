"use client";

import Link from "next/link";
import { useAuth, UserButton, SignInButton, SignUpButton } from "@clerk/nextjs";

export default function Navbar() {
  const { isSignedIn } = useAuth();

  return (
    <header style={{ borderBottom: "1px solid var(--rd-border)", background: "var(--rd-paper)" }}>
      <nav className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
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

        {/* Utility links */}
        <div className="flex items-center gap-6">
          {isSignedIn ? (
            <>
              <Link
                href="/collection"
                className="font-mono text-xs uppercase tracking-wide hover:text-[var(--rd-ink)] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                style={{ color: "var(--rd-ink-secondary)", outlineColor: "var(--rd-accent)" }}
              >
                My Words
              </Link>
              <UserButton afterSignOutUrl="/" />
            </>
          ) : (
            <>
              <SignInButton mode="redirect">
                <button
                  className="font-mono text-xs uppercase tracking-wide hover:text-[var(--rd-ink)] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                  style={{ color: "var(--rd-ink-secondary)", outlineColor: "var(--rd-accent)" }}
                >
                  Sign in
                </button>
              </SignInButton>
              <SignUpButton mode="redirect">
                <button
                  className="font-sans text-sm font-medium px-4 py-1.5 rounded-md transition-colors hover:bg-[var(--rd-accent-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                  style={{
                    background: "var(--rd-accent)",
                    color: "#ffffff",
                    outlineColor: "var(--rd-accent)",
                  }}
                >
                  Sign up
                </button>
              </SignUpButton>
            </>
          )}
        </div>
      </nav>
    </header>
  );
}
