-- RD-06: remove the userbase (Clerk-auth-backed credits/saved-words/games)
-- entirely. Drops GameRound and Lookup first (FK to User), then SavedWord
-- (FK to Word), then User. VocabEmbedding/GlossEmbedding/ShadowLookup and
-- Word itself are untouched -- none of them relate to these tables.
--
-- *** DESTRUCTIVE — irreversible without a restore. Any real saved-word
-- collections or credit balances in this database are gone once this runs.
-- Do not run against the shared Neon database without explicit confirmation.
-- Neon's pooled connection breaks prisma migrate deploy's advisory lock; per
-- CLAUDE.md, apply with `prisma db execute --file` instead. ***

-- DropForeignKey
ALTER TABLE "GameRound" DROP CONSTRAINT "GameRound_userId_fkey";

-- DropForeignKey
ALTER TABLE "Lookup" DROP CONSTRAINT "Lookup_userId_fkey";

-- DropForeignKey
ALTER TABLE "SavedWord" DROP CONSTRAINT "SavedWord_wordId_fkey";

-- DropTable
DROP TABLE "GameRound";

-- DropTable
DROP TABLE "Lookup";

-- DropTable
DROP TABLE "SavedWord";

-- DropTable
DROP TABLE "User";
