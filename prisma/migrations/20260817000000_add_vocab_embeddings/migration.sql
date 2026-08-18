-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateTable
CREATE TABLE "VocabEmbedding" (
    "id" SERIAL NOT NULL,
    "word" TEXT NOT NULL,
    "embedding" vector(384) NOT NULL,

    CONSTRAINT "VocabEmbedding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VocabEmbedding_word_key" ON "VocabEmbedding"("word");

-- CreateIndex (IVFFlat for approximate cosine-distance nearest-neighbor search)
-- lists=150 is ~rows/1000 for 141k vocab entries
CREATE INDEX "VocabEmbedding_embedding_ivfflat_idx"
    ON "VocabEmbedding"
    USING ivfflat ("embedding" vector_cosine_ops)
    WITH (lists = 150);
