"use client";

import Link from "next/link";
import { useAuth, UserButton, SignInButton, SignUpButton } from "@clerk/nextjs";

export default function Navbar() {
  const { isSignedIn } = useAuth();

  return (
    <header style={{ borderBottom: "1px solid var(--border)", background: "var(--bg)" }}>
      <nav className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
        {/* Logo */}
        <Link href="/" className="flex items-center gap-2">
          <span
            className="font-serif text-xl leading-none"
            style={{ color: "var(--accent-gold)" }}
          >
            ◈
          </span>
          <span
            className="font-serif text-lg tracking-tight"
            style={{ color: "var(--text-primary)" }}
          >
            Reverse Dictionary
          </span>
        </Link>

        {/* Auth controls */}
        <div className="flex items-center gap-4">
          {isSignedIn ? (
            <>
              <Link
                href="/collection"
                className="font-mono text-sm transition-colors"
                style={{ color: "var(--text-secondary)" }}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.color = "var(--text-primary)")
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.color = "var(--text-secondary)")
                }
              >
                My Words
              </Link>
              <UserButton afterSignOutUrl="/" />
            </>
          ) : (
            <>
              <SignInButton mode="redirect">
                <button
                  className="font-mono text-sm px-3 py-1.5 rounded transition-colors"
                  style={{
                    color: "var(--text-secondary)",
                    border: "1px solid var(--border)",
                  }}
                >
                  Sign in
                </button>
              </SignInButton>
              <SignUpButton mode="redirect">
                <button
                  className="font-mono text-sm px-3 py-1.5 rounded font-medium transition-opacity hover:opacity-90"
                  style={{
                    background: "var(--accent-gold)",
                    color: "var(--bg)",
                  }}
                >
                  Sign up →
                </button>
              </SignUpButton>
            </>
          )}
        </div>
      </nav>
    </header>
  );
}
