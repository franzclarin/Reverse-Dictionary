# CLAUDE.md

Guidance for working in this repo. Keep this file current when architecture or workflows change.

## What this is

A **reverse dictionary** web app: the user describes a concept ("the smell of rain on dry earth") and gets the word. Retrieval is powered by a **fine-tuned sentence-embedding model** over a 141k-word vocabulary, with semantic search via pgvector.

## Stack

- **Next.js 14** (App Router, TypeScript) + **Tailwind CSS**
- **Neon Postgres** + **Prisma 5** — `pgvector` extension for embeddings
- **Clerk** auth (middleware runs on all routes; app is usable signed-out)
- **Upstash Redis + Ratelimit** — lazy, null-guarded via `getRatelimiters()` (no-op when env vars absent)
- **@xenova/transformers** (Transformers.js) — in-function ONNX embedding
- **Anthropic Claude** — legacy `/api/reverse-dictionary` route (still present, no longer called from search UI)
- Deployed on **Vercel** (region `iad1`); GitHub `franzclarin/Reverse-Dictionary`, branch `main`

## How search works (the core flow)

1. `app/page.tsx` `handleSearch()` → POST `/api/lookup` only. **No Claude fallback** — errors surface directly (with the server's `detail`).
2. `app/api/lookup/route.ts`:
   - `embed(query)` (`lib/embedder.ts`) → 384-dim L2-normalised vector.
   - pgvector query inside a `$transaction` with `SET LOCAL ivfflat.probes = 10`:
     `ORDER BY embedding <=> $1::vector LIMIT $2`, similarity = `1 - (embedding <=> …)`.
   - Returns `{ results: [{ word, similarity }] }`.
3. UI navigates to `/word/[top.word]` with runners-up as `?alternatives=`.

## Embedding model — important context

- `lib/embedder.ts` loads ONNX model **`franzclarin/ReverseDictionary`** via Transformers.js with `{ quantized: false }` (uses `onnx/model.onnx`), then `{ pooling: "mean", normalize: true }`. This reproduces the sentence-transformers pipeline (Transformer → mean Pooling → Normalize) that seeded the DB, so query vectors match stored vectors.
- Singleton via `globalThis._embedderPromise`; cache dir forced to `/tmp/transformers_cache` (only writable path on Vercel). Route sets `runtime = "nodejs"`, `maxDuration = 60`.
- `next.config.js` has `serverComponentsExternalPackages: ["@xenova/transformers"]` so the native ONNX runtime isn't webpack-bundled.
- **Do NOT switch to the HF serverless Inference API.** The free `hf-inference` provider returns `"Model not supported by provider hf-inference"` for this custom model regardless of metadata. A paid HF Inference Endpoint would work; the project deliberately uses free in-function embedding instead.
- Original model artifacts: `reverse_dict_model.zip` (gitignored, repo root) contains the full sentence-transformers model incl. `model.safetensors`.

## Data model (`prisma/schema.prisma`)

Models: `Word`, `SavedWord`, `User`, `Lookup`, `GameRound`, `VocabEmbedding`.
- `VocabEmbedding { id, word @unique, embedding Unsupported("vector(384)") }` — 141,854 rows, IVFFlat index (`vector_cosine_ops`, `lists = 150`).
- pgvector columns use `Unsupported("vector(384)")`; query them with `$queryRawUnsafe` and a `[..]` vector literal, never the typed Prisma client.

## API routes (`app/api/`)

- `lookup/` — embedding search (primary).
- `reverse-dictionary/` — Claude-based lookup (legacy; not wired to UI).
- `word/[word]/`, `word/[word]/save/` — word page data + saving.
- `credits/`, `leaderboard/` — user credits / leaderboard.

## Conventions & gotchas

- **Read `response.json()` defensively**: parse in a try/catch, THEN check `response.ok`. An empty body (Vercel gateway 401/502, crashed function) otherwise throws "Unexpected end of JSON input". Both search routes and the client already do this.
- Keep `auth()` and rate-limiting **inside** the route's top-level try/catch so failures return JSON, never an empty-body 500.
- Rate limiters are optional — always null-check `getRatelimiters()`.
- Migrations: Neon pooled connections break `prisma migrate deploy`'s advisory lock — apply SQL via `prisma db execute --file` instead.
- Env: local `.env.local` needs `DATABASE_URL` (Neon owner role), Clerk keys, and optionally Upstash + `ANTHROPIC_API_KEY`. Vercel needs the same for the deployed app.

## Commands

```bash
npm run dev            # local dev
npm run build          # prod build
npm run lint
npx tsc --noEmit       # type-check (run before committing)
```

## Repo hygiene

- Platform: Windows / PowerShell. `_model_tmp/` and `reverse_dict_model.zip` are gitignored (large model/seed artifacts).
- Other docs: `ARCHITECTURE.md`, `DEPLOYMENT.md`, `GETTING_STARTED.md`, `SETUP.md`, `README.md`.
