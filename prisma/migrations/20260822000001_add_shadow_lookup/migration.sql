-- Shadow-log table for the gloss-index cutover decision (CLAUDE.md "Next
-- steps"). NOT YET APPLIED to the production database as of this migration
-- audit (2026-08-22) — see MIGRATION_AUDIT.md's Phase 3 entry. Unlike the
-- GlossEmbedding migration, this one is low-risk on its own (a new, empty
-- table with no vector column and no size pressure against the 512MB
-- ceiling) — but it's still a production schema change, and the route
-- instrumentation that writes to it (lib/shadowLookup.ts,
-- app/api/lookup/route.ts) has not been deployed either. Both are left for
-- explicit user review before either the migration is applied or the route
-- change is pushed to main.

-- CreateTable
CREATE TABLE "ShadowLookup" (
    "id"            TEXT NOT NULL,
    "queryHash"     TEXT NOT NULL,
    "oldTop1"       TEXT NOT NULL,
    "oldSimilarity" DOUBLE PRECISION NOT NULL,
    "newTop1"       TEXT NOT NULL,
    "newSimilarity" DOUBLE PRECISION NOT NULL,
    "agree"         BOOLEAN NOT NULL,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShadowLookup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ShadowLookup_createdAt_idx" ON "ShadowLookup"("createdAt");
