"use client";

import { useEffect } from "react";
import { useExplainRun } from "./useExplainRun";
import InstrumentShell from "./InstrumentShell";
import { useSound } from "@/context/SoundContext";

/**
 * Loads the two static assets, then hands off to the one layout.
 *
 * The three-shell picker this briefly carried is gone: variant B was chosen and
 * the other two were deleted rather than left behind as dead code.
 */
export default function ExplainClient() {
  const { assets, assetError, run, search } = useExplainRun();
  const { play } = useSound();

  // A landed result is the app's own "stamp" moment; reuse the same effect the
  // search page plays so the two pages sound like one product.
  useEffect(() => {
    if (run.phase === "done") play(run.results.length > 0 ? "stamp" : "error");
    if (run.phase === "error") play("error");
  }, [run.phase, run.results.length, play]);

  if (assetError) {
    return (
      <main className="max-w-3xl mx-auto px-6 py-24" style={{ background: "var(--rd-paper)" }}>
        <p className="font-mono" style={{ fontSize: 13, color: "var(--rd-error)" }}>
          {assetError}
        </p>
      </main>
    );
  }

  if (!assets) {
    return (
      <main
        className="flex items-center justify-center"
        style={{ background: "var(--rd-paper)", minHeight: "60vh" }}
      >
        <div className="loading-content">
          <div className="loading-spinner" />
          <p className="loading-subtext">projecting 384 dimensions onto 3</p>
        </div>
      </main>
    );
  }

  return <InstrumentShell snapshot={assets.snapshot} run={run} search={search} />;
}
