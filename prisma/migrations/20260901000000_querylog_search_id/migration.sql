-- One row per search intent (RD-25, 2026-09-01).
--
-- RD-24 wrote a row per REQUEST, and the UI sends two: React StrictMode
-- double-invokes the effect in components/SearchResults.tsx, which had no
-- cleanup, so both fetches reached the server. The client is fixed to fire
-- once; this unique index is the guarantee that a duplicate arrival cannot
-- become a second row regardless.
--
-- The DELETE runs first so the column can be NOT NULL with no backfill. Every
-- existing row is a curl test or a StrictMode duplicate — there is no real
-- usage in this table yet, which is the only reason discarding it is safe.
--
-- Apply with `prisma db execute --file`, NOT `prisma migrate deploy` — Neon's
-- pooled connections break the advisory lock migrate deploy takes.

DELETE FROM "QueryLog";

-- AlterTable
ALTER TABLE "QueryLog" ADD COLUMN "searchId" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "QueryLog_searchId_key" ON "QueryLog"("searchId");
