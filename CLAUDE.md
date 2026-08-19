# CLAUDE.md

Guidance for working in this repo. Keep this file current when architecture or workflows change.

## What this is

A **reverse dictionary** web app: the user describes a concept ("the smell of rain on dry earth") and gets the word. Retrieval is powered by a **fine-tuned sentence-embedding model** over a 141k-word vocabulary, with semantic search via pgvector.

## Stack

- **Next.js 14** (App Router, TypeScript) + **Tailwind CSS**
- **Neon Postgres** + **Prisma 5** — `pgvector` extension for embeddings
- **Clerk** auth (middleware runs on all routes; app is usable signed-out)
- **Upstash Redis + Ratelimit** — Vercel Marketplace resource (`upstash/upstash-kv`). Built lazily by `getRatelimiters()`, no-op when env vars are absent, and **fails open** when the limiter itself errors
- **@xenova/transformers** (Transformers.js) — in-function ONNX embedding
- **No generative AI dependency.** Claude was removed entirely on 2026-08-18 — search never used it, and word pages no longer do (see "Word pages"). There is no `@anthropic-ai/sdk` and no `ANTHROPIC_API_KEY`
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

## Word pages — no generative API

`/word/[word]` is powered **entirely by the embedding model**; there is no Claude call anywhere in the flow.

- An embedding model has no decoder, so it **cannot** produce a definition, etymology, pronunciation, or examples. Don't try to restore those from it.
- `getRelatedWords()` (`lib/wordData.ts`) is the core of the page: nearest neighbours by cosine distance over `VocabEmbedding`. It reads the word's **stored** vector via a subquery, so it never loads ONNX — pure pgvector, fast.
- `getWordData()` returns an existing `Word` row if present (words profiled before Claude was removed keep their definition — reading them is free), otherwise creates a **minimal row with empty text fields** so the word has a stable id for `SavedWord`. The page renders around whatever is empty.
- **Gotcha:** those minimal rows are indistinguishable from a real profile by presence alone. If a generative source is ever added back, regenerate on `definition === ""`, not on row-absence, or every word visited during this era will stay blank forever.
- Both `getWordData` and `getRelatedWords` are wrapped in React `cache()` so the page and `generateMetadata` share one query per request instead of duplicating it.
- `app/word/[word]/error.tsx` is the boundary that keeps a server-side exception from surfacing as Next's bare "Application error … Digest: …".
- **Known cosmetic issue:** with `dynamic = "force-dynamic"`, `notFound()` renders the correct 404 page but the HTTP status is already committed as 200. Pre-existing; matters only for SEO.

## Data model (`prisma/schema.prisma`)

Models: `Word`, `SavedWord`, `User`, `Lookup`, `GameRound`, `VocabEmbedding`.
- `VocabEmbedding { id, word @unique, embedding Unsupported("vector(384)") }` — 141,854 rows, IVFFlat index (`vector_cosine_ops`, `lists = 150`).
- pgvector columns use `Unsupported("vector(384)")`; query them with `$queryRawUnsafe` and a `[..]` vector literal, never the typed Prisma client.

## API routes (`app/api/`)

- `lookup/` — embedding search (primary).
- `word/[word]/`, `word/[word]/save/` — word page data + saving.
- `credits/`, `leaderboard/` — user credits / leaderboard.

## Conventions & gotchas

- **Read `response.json()` defensively**: parse in a try/catch, THEN check `response.ok`. An empty body (Vercel gateway 401/502, crashed function) otherwise throws "Unexpected end of JSON input". Both search routes and the client already do this.
- Keep `auth()` and rate-limiting **inside** the route's top-level try/catch so failures return JSON, never an empty-body 500.
- Rate limiters are optional — always null-check `getRatelimiters()`.
- **"fetch failed" is never the real error.** Node/undici throws a bare `TypeError: fetch failed` for every network fault and hides the reason on `error.cause` (`code`, `errno`, `hostname`) — sometimes nested, sometimes inside an `AggregateError.errors`. Never log or return `err.message` alone. Use `describeError()` / `formatErrorShape()` from `lib/errors.ts`, which flatten the whole cause chain.
- **Tag failures by subsystem.** `/api/lookup` has exactly three outbound-fetch dependencies; each one produces an identical "fetch failed". Wrap each and throw `SubsystemError(subsystem, …)` so the log line (`[lookup] FAILED subsystem=…`) and the client's `detail` name the culprit:
  - `model` — Transformers.js pulling `franzclarin/ReverseDictionary` from the HF CDN on cold start.
  - `database` — the pgvector query. (Prisma here is **plain TCP**, not `@prisma/adapter-neon` / `@neondatabase/serverless`, so it does *not* use fetch. It only appears as "fetch failed" if someone swaps in a fetch-based driver.)
  - `ratelimit` — `@upstash/redis` is REST-over-`fetch`.
- **Rate limiting must fail open.** `getRatelimiters()` guards *absent* env vars, but a **present-but-stale** `UPSTASH_REDIS_REST_URL` (deleted DB, rotated creds) makes `.limit()` throw `fetch failed` / `ENOTFOUND` *before* the model is ever touched — it took down all of search. `checkRateLimit()` now catches, logs `FAILING OPEN`, and allows the request. Build the limiters **lazily**, not at module scope: a malformed URL makes `new Redis()` throw during route init, which yields an empty-body 500 that the client can't parse.
- **Never cache a rejected promise.** `globalThis._embedderPromise` memoises the model load. If a rejected promise stays in that slot, every later request on the same warm instance fails instantly with the same stale error forever, even after the network heals. `getEmbedder()` clears the slot on rejection (guarded by identity check); `loadEmbedder()` retries 3× with exponential backoff and bails early on non-network errors so it doesn't burn the 60s budget.
- Observed cause codes: `ENOTFOUND` (bad/stale host), `ECONNREFUSED` (host up, nothing listening), plus `EAI_AGAIN` / `UND_ERR_CONNECT_TIMEOUT` for DNS and CDN stalls.
- The error `detail` returned to the client includes `subsystem` + `code`, but **`hostname` only outside production** (an Upstash REST host identifies a private DB). The full shape is always in the server logs.
- Migrations: Neon pooled connections break `prisma migrate deploy`'s advisory lock — apply SQL via `prisma db execute --file` instead.
- Env: local `.env.local` needs `DATABASE_URL` (Neon owner role), Clerk keys, and optionally Upstash (`KV_REST_API_URL` / `KV_REST_API_TOKEN`). Vercel needs the same for the deployed app.
- **Redis creds come from `KV_*`, not `UPSTASH_*`.** The Upstash Redis DB is a Vercel Marketplace resource (`upstash/upstash-kv`), which writes `KV_REST_API_URL` / `KV_REST_API_TOKEN` and keeps them in sync with the resource. `getRatelimiters()` reads those first and only falls back to `UPSTASH_REDIS_REST_URL` / `_TOKEN`. Don't hand-copy credentials into the `UPSTASH_*` pair — a hand-set pair outlived its deleted database by 166 days and caused the outage above. Re-provision with `vercel integration add upstash/upstash-kv`; `vercel integration list` shows whether a resource actually exists (env vars alone prove nothing).

## Commands

```bash
npm run dev            # local dev
npm run build          # prod build
npm run lint
npx tsc --noEmit       # type-check (run before committing)
```

## Repo hygiene

- Platform: Windows / PowerShell. `_model_tmp/` and `reverse_dict_model.zip` are gitignored (large model/seed artifacts).
- **Deploy by pushing to `main`** — the Git integration clones the repo, so `.gitignore` applies and the build is correct. `vercel deploy --prod` **fails**: the CLI uploads the working directory instead, sweeping in `reverse_dict_model.zip` and `_model_tmp/` (~1.5GB) and blowing the 100MB per-file cap. `.gitignore` does not apply to CLI deploys — only `.vercelignore` does, and there isn't one.
- The repo lives under OneDrive. Its placeholder files make Next's startup cleanup of `.next` fail with `EINVAL: readlink …`, and `next dev` then **exits 0 without serving**. If dev dies instantly, `rm -rf .next` and restart.
- ESLint config is `.eslintrc.json` (`next/core-web-vitals`). Without it `npm run lint` drops into an interactive setup wizard and hangs non-interactive shells.
- Other docs: `ARCHITECTURE.md`, `DEPLOYMENT.md`, `GETTING_STARTED.md`, `SETUP.md`, `README.md`.
