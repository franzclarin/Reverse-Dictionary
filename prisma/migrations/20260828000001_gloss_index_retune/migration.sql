-- RD-17: rebuild the gloss IVFFlat index for the expanded row count.
--
-- WHY THIS IS NOT OPTIONAL. `lists = 115` was chosen when "GlossEmbedding" held
-- 117,791 rows, and IVFFlat's `lists` is what defines the unit `probes` counts
-- in: each probe scans roughly rows/lists candidates. RD-17 took the table to
-- 693,325 rows, so leaving lists at 115 would make every probe scan ~6,000 rows
-- instead of ~1,000 — the same `probes = 40` would mean something completely
-- different, and the measured sweep behind that number would no longer describe
-- anything. `lists` and `probes` are one setting with two halves.
--
-- 833 = round(sqrt(693,325)), pgvector's own guidance for a table this size.
-- GLOSS_PROBES in lib/glossSearch.ts is re-swept against this index; do not
-- change one without the other.
--
-- Apply with `prisma db execute --file` — Neon's pooled connections break
-- `prisma migrate deploy`'s advisory lock (see CLAUDE.md, "Migrations"). The
-- build is a minutes-long operation that holds no exclusive lock on reads;
-- searches keep working against the old index until the swap.
-- Neon's default `maintenance_work_mem` is 64 MB and an IVFFlat build over
-- 693,325 halfvec(384) rows at lists = 833 needs 169 MB: without this the
-- CREATE fails with `memory required is 169 MB`. The whole file runs as one
-- transaction, so a failure here rolls the DROP back too and the serving index
-- survives — which is why this is safe to retry rather than a window of
-- unindexed production. Session-scoped; it does not change the instance.
SET maintenance_work_mem = '512MB';

DROP INDEX IF EXISTS "GlossEmbedding_embedding_ivfflat_idx";

CREATE INDEX "GlossEmbedding_embedding_ivfflat_idx"
    ON "GlossEmbedding"
    USING ivfflat ("embedding" halfvec_cosine_ops)
    WITH (lists = 833);
