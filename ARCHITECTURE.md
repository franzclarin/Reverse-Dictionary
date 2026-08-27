# Reverse Dictionary - Architecture Documentation

## Overview

A reverse dictionary application that finds words from concept descriptions using **semantic search over a fine-tuned sentence-embedding model** — not a generative model. There is no LLM call anywhere in the search or word-page flow; the entire "understanding" of a query is one forward pass through an embedding model, compared against pre-computed word vectors.

Claude/Anthropic was removed from this app entirely on 2026-08-18. There is no `@anthropic-ai/sdk` and no `ANTHROPIC_API_KEY` anywhere in the codebase.

## Stack Selection

### Frontend & Backend
- **Framework**: Next.js 14 (App Router)
- **Language**: TypeScript
- **Styling**: Tailwind CSS
- **Deployment**: Vercel (region `iad1`)

### Retrieval
- **Model**: `franzclarin/ReverseDictionary`, a sentence-transformer fine-tuned on WordNet (gloss, lemma, negative-lemma) triplets
- **Runtime**: Transformers.js (ONNX), loaded and run **inside the Vercel function itself** — not a call to a hosted inference API. `quantized: false`, `{ pooling: "mean", normalize: true }`, matching the pipeline that produced the stored database vectors.
- **Index**: Neon Postgres + `pgvector`, queried via Prisma 5's `$queryRawUnsafe` (the vector column is `Unsupported("vector(384)")`, so the typed client can't touch it)

### Why Next.js + Vercel?
1. Serverless functions run the embedding model in-function with no separate inference service to operate
2. First-class TypeScript support
3. Zero-config deployment, hot reload, file-based routing
4. `serverComponentsExternalPackages: ["@xenova/transformers"]` keeps the native ONNX runtime out of the webpack bundle so Vercel ships its binaries correctly

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         User Browser                         │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Next.js Frontend                                      │  │
│  │  • SearchInput (landing page)                          │  │
│  │  • SearchResults / ResultListItem (results page)       │  │
│  │  • Word page (related words)                            │  │
│  └──────────────────┬──────────────────────────────────┘    │
└────────────────────│─────────────────────────────────────────┘
                     │ HTTPS
                     ▼
┌─────────────────────────────────────────────────────────────┐
│              POST /api/lookup  (Node.js runtime, 60s)        │
│                                                               │
│  1. embed(query) — Transformers.js ONNX, in-function         │
│  2. pgvector: ORDER BY embedding <=> $1 LIMIT k              │
│     (SET LOCAL ivfflat.probes = 10, inside a transaction)    │
│  3. return { results: [{ word, similarity }], timingMs }     │
└────────────────────│─────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│            Neon Postgres — "VocabEmbedding"                  │
│  141,854 rows, one per vocabulary word, vector(384),          │
│  IVFFlat index (vector_cosine_ops, lists = 150)               │
└─────────────────────────────────────────────────────────────┘
```

Word pages (`/word/[word]`) follow a separate, cheaper path: `getRelatedWords()` reads the word's **already-stored** vector via a subquery and finds nearest neighbours — it never re-runs the ONNX model. `getWordData()` returns an existing `Word` row if one was profiled before the Claude removal, or creates a minimal row with empty text fields otherwise; there is no generative fallback that could fill those fields in.

## Data Flow

1. **User input** — a query typed on the landing page (`app/page.tsx`) routes to `/search?q=...`, which owns the actual `/api/lookup` call so every entry point (landing page, results page's own search bar) goes through one code path.
2. **Frontend → `/api/lookup`** — `POST { query: string, k?: number }`.
3. **Embed** — `embed(query)` produces a 384-dim, L2-normalized vector (mean pooling over token embeddings, then normalize).
4. **pgvector search** — cosine distance (`<=>`) against `VocabEmbedding`'s 141,854 rows via an approximate IVFFlat index (`lists = 150`, `probes = 10` set per-query). This trades a small amount of recall (~0.3pp measured) for speed over an exact sequential scan.
5. **Response** — `{ results: [{ word, similarity }], timingMs }`; `similarity = 1 - cosine_distance`.
6. **Frontend display** — the results page renders the ranked list; clicking a word navigates to its page, which runs the separate `getRelatedWords()`/`getWordData()` path described above.

There is no system prompt, no JSON-contract parsing, and no retry-on-malformed-response logic anywhere in this flow — retrieval is a single vector comparison, not a model "answering" a question.

## Known Limitations (measured, not hypothetical)

- **Lexical echo**: `VocabEmbedding` stores each word's *own* embedding (not a definition), so a multi-word query is compared against single-token vectors. ~34% of top-10 results share a word stem with the query and outscore the actual intended answer.
- **The fine-tune's contribution is small**: swapping in the untouched base model only costs ~4.5 points of lenient Recall@1 — a measured null result against the pre-committed bar.
- **A gloss-indexed alternative** (embedding WordNet definitions per sense instead of bare words) measured +13-16 points of lenient Recall@1 offline and is **designed but not deployed** — see CLAUDE.md's "Phase E" and the dormant `GlossEmbedding`/`ShadowLookup` schema in `prisma/schema.prisma`.

Full measurement methodology, the offline eval harness, and the frozen eval set live in **[CLAUDE.md](CLAUDE.md)** — that file is the maintained source of truth for retrieval internals; this document should not duplicate it.

## Project Structure

```
Reverse-Dictionary/
├── app/
│   ├── api/
│   │   ├── lookup/route.ts
│   │   └── word/[word]/route.ts
│   ├── page.tsx, search/page.tsx, word/[word]/page.tsx
│   ├── icon.svg              # Favicon (Next App Router file convention)
│   ├── layout.tsx, globals.css
├── components/
│   ├── SearchInput.tsx, SearchResults.tsx, ResultListItem.tsx
│   ├── Navbar.tsx, WordLink.tsx, WordShareButtons.tsx
├── lib/
│   ├── embedder.ts          # Transformers.js singleton, retry/backoff, never caches a rejected promise
│   ├── wordData.ts          # getWordData / getRelatedWords, both wrapped in React cache()
│   ├── errors.ts            # describeError/formatErrorShape/SubsystemError — flattens fetch-failed cause chains
│   └── prisma.ts
├── prisma/
│   └── schema.prisma
├── scripts/, eval/          # Offline retrieval evaluation harness (see CLAUDE.md)
└── next.config.js
```

Environment variables are listed in README.md; there are only two (`DATABASE_URL`, `NEXT_PUBLIC_SITE_URL`).

## Security Considerations

1. **No LLM API key to protect** — there is no Anthropic key or equivalent in this app anymore.
2. **No auth, no rate limiting** — there is no userbase and nothing to authenticate; `/api/lookup` is fully anonymous and unthrottled (removed 2026-08-26, see CLAUDE.md).
3. **Input validation**: query must be a non-empty string ≤500 characters.
4. **Error responses never leak internals**: `hostname` in error `detail` is stripped outside dev (it can identify a private database host); the full error shape is always in server logs.

## Performance Notes

1. **Cold start**: the embedding model is loaded on-demand and cached per warm instance (`globalThis._embedderPromise`); `maxDuration = 60` on `/api/lookup` accounts for a cold model download taking up to ~20s. The promise is deliberately cleared on rejection so one bad network blip doesn't wedge every subsequent request on that instance.
2. **Approximate index**: IVFFlat trades a small amount of recall for large speed gains over an exact scan — see CLAUDE.md for the measured cost.
3. **`React cache()`** on `getWordData`/`getRelatedWords` means the word page and its `generateMetadata` share one query per request instead of duplicating it.

Deployment steps, checklist, and production troubleshooting live in **[DEPLOYMENT.md](DEPLOYMENT.md)** — not duplicated here.

## Open / Staged Work

A synset-keyed gloss index (`GlossEmbedding`, `halfvec(384)`) and a shadow-log cutover gate (`ShadowLookup`) are designed, type-checked, and committed as **dormant** — no migration applied, no rows populated, the route hook gated behind a hardcoded `false`. See `prisma/schema.prisma`'s comments on those two models and `scripts/build-gloss-index.ts` / `scripts/shadow-compare.ts` for what a real cutover would require.
