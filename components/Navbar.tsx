"use client";

import Link from "next/link";
import { useAuth, UserButton, SignInButton, SignUpButton } from "@clerk/nextjs";

export default function Navbar() {
  const { isSignedIn } = useAuth();

  return (
    <header style={{ borderBottom: "1px solid var(--gs-border)", background: "var(--gs-bg)" }}>
      <nav className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
        {/* Logo mark */}
        <Link
          href="/"
          className="flex items-center gap-2 rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
          style={{ outlineColor: "var(--gs-accent)" }}
        >
          <span
            className="font-google text-lg leading-none"
            style={{ color: "var(--gs-accent)" }}
          >
            ◈
          </span>
          <span
            className="font-google text-lg"
            style={{ color: "var(--gs-text-primary)" }}
          >
            Reverse Dictionary
          </span>
        </Link>

        {/* Utility links */}
        <div className="flex items-center gap-5">
          {isSignedIn ? (
            <>
              <Link
                href="/collection"
                className="font-google text-sm hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                style={{ color: "var(--gs-text-secondary)", outlineColor: "var(--gs-accent)" }}
              >
                My Words
              </Link>
              <UserButton afterSignOutUrl="/" />
            </>
          ) : (
            <>
              <SignInButton mode="redirect">
                <button
                  className="font-google text-sm hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                  style={{ color: "var(--gs-text-secondary)", outlineColor: "var(--gs-accent)" }}
                >
                  Sign in
                </button>
              </SignInButton>
              <SignUpButton mode="redirect">
                <button
                  className="font-google text-sm px-4 py-1.5 rounded transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                  style={{
                    background: "var(--gs-accent)",
                    color: "#ffffff",
                    outlineColor: "var(--gs-accent)",
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
