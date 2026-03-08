"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

export default function CreditsDisplay() {
  const [credits, setCredits] = useState<number | null>(null);

  useEffect(() => {
    fetch("/api/credits")
      .then((r) => r.json())
      .then((d) => {
        if (typeof d.credits === "number") setCredits(d.credits);
      })
      .catch(() => {});
  }, []);

  if (credits === null) return null;

  return (
    <Link
      href="/games"
      className="font-mono text-sm transition-colors"
      style={{ color: "var(--accent-gold)" }}
      title="Go to Games"
    >
      ◈ {credits.toLocaleString()} credits
    </Link>
  );
}
