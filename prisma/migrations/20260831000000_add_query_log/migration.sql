-- Query log for /api/lookup (RD-24, 2026-08-31).
--
-- This is the migration that retires the "no query text has ever been logged"
-- property. ShadowLookup (20260822000001) stores a sha256 and top-1 only,
-- deliberately, so that no query text reached the database; this table stores
-- the description as typed alongside every word and score returned for it.
--
-- Low-risk on its own: a new, empty table with no vector column and no size
-- pressure. It is still a production schema change and a change of posture, so
-- it is documented in CLAUDE.md, README.md and ARCHITECTURE.md rather than
-- silently falsifying them.
--
-- Apply with `prisma db execute --file`, NOT `prisma migrate deploy` — Neon's
-- pooled connections break the advisory lock migrate deploy takes.

-- CreateTable
CREATE TABLE "QueryLog" (
    "id"          TEXT NOT NULL,
    "query"       TEXT NOT NULL,
    "k"           INTEGER NOT NULL,
    "results"     JSONB NOT NULL,
    "resultCount" INTEGER NOT NULL,
    "timingMs"    INTEGER NOT NULL,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QueryLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QueryLog_createdAt_idx" ON "QueryLog"("createdAt");
