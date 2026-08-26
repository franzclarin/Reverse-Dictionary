-- Production synset-keyed gloss index (CLAUDE.md "Next steps").
--
-- NOT YET APPLIED to the production database as of this migration audit
-- (2026-08-22) — see MIGRATION_AUDIT.md's Phase 3 entry. Everything below
-- CREATE TABLE / CREATE INDEX is safe to apply on its own (it only adds a new,
-- empty table). The DROP INDEX at the bottom is the hard-stop this session
-- did not cross: VocabEmbedding's IVFFlat index has to be dropped to free the
-- ~230MB "GlossEmbedding" needs to fit under Neon's 512MB project-size
-- ceiling (CLAUDE.md: an attempt to stage a second index without dropping the
-- first failed with `53100 project size limit exceeded`). Uncomment and run
-- that line only after explicit confirmation — VocabEmbedding's bare vectors
-- stay in place either way as the exact-search rollback path; only the index
-- over them is dropped.

-- CreateTable
CREATE TABLE "GlossEmbedding" (
    "id"        SERIAL NOT NULL,
    "synsetKey" TEXT NOT NULL,
    "pos"       TEXT NOT NULL,
    "gloss"     TEXT NOT NULL,
    "lemmas"    TEXT[] NOT NULL,
    "embedding" halfvec(384) NOT NULL,

    CONSTRAINT "GlossEmbedding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GlossEmbedding_synsetKey_key" ON "GlossEmbedding"("synsetKey");

-- CreateIndex (IVFFlat over halfvec; lists ~ rows/1000, same heuristic as
-- VocabEmbedding's `lists = 150` for ~141k rows)
CREATE INDEX "GlossEmbedding_embedding_ivfflat_idx"
    ON "GlossEmbedding"
    USING ivfflat ("embedding" halfvec_cosine_ops)
    WITH (lists = 115);

-- *** HARD STOP — not run by this migration audit, requires explicit user
-- *** confirmation first (this is named hard-stop #2: "Any write to the
-- *** production VocabEmbedding table or its indexes"). Frees ~230MB, which
-- *** is what makes room for GlossEmbedding under the 512MB ceiling.
-- DROP INDEX "VocabEmbedding_embedding_ivfflat_idx";
