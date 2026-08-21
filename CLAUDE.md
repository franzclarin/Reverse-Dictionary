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
- **Dev-only, evaluation tooling:** `tsx` (runs `scripts/*.ts`) and `wordnet-db` (build-time WordNet 3.0 gloss/coverage data). Neither is imported by the app, and `wordnet-db` never touches `eval/sets/` — the eval set is hand-authored and stays blind to every gloss. See "Evaluation".

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

## Evaluation (`scripts/`, `eval/`) — additive tooling, read-only

Offline harness measuring the real retrieval path (`embed(query)` → pgvector top-k) against a frozen set of (description → word) pairs. Built because the fine-tune was scored in Colab against in-batch negatives, while production ranks against 141,854 candidates through an approximate index — different problems that can disagree.

**Rules that keep it honest.** Read-only against the database. The app is never modified: `scripts/lib/retrieval.ts` *mirrors* `app/api/lookup/route.ts` (same `$transaction`, same `SET LOCAL ivfflat.probes`, same `<=>` ordering) and `eval.ts` imports `embed` from `lib/embedder.ts` rather than reimplementing it. A second embedding path would make every number fiction. Dev-only deps: `tsx`, `wordnet-db` (build-time gloss/coverage data, never imported by the app).

### Established facts — verified, do not re-derive

- **The WordNet training corpus is unsplit and unusable for evaluation.** The model card inside `reverse_dict_model.zip` (`sentence_model/README.md`) records 181,149 (gloss, lemma, negative-lemma) triplets, `MultipleNegativesRankingLoss`, **3 epochs, no evaluator, no held-out split** (`eval_on_start: False`, `prediction_loss_only: True`). Its sample rows are verbatim WordNet glosses. Any WordNet-gloss-derived eval slice is ~100% leaked. This is why the eval set is hand-authored.
- **`VocabEmbedding` stores bare-lemma embeddings.** `cos(embed(word), stored[word]) = 1.000000 ± 1e-6` across 24 probe words (`scripts/probe-representation.ts`). Corroborated structurally: `vocab.index` is 217,887,789 bytes = 141,854 × 384 × 4 + 45. Search matches a 12-word description against a 1-token document. This is *consistent with* training (`directions: ["query_to_doc"]`), so it is not a train/serve mismatch — the fine-tune simply did not achieve its own objective.
- **No query text has ever been logged.** `Lookup` is `{id, userId, createdAt}` — a rate-limit counter. `GameRound` is the credits casino (`coinflip`, `slots`, …), not a word game. There is no sample of real user queries to draw on, and the eval set cannot pretend to be one.
- **`VocabEmbedding` ⊂ WordNet 3.0, ~95% of it, with no POS skew.** Presence excluding numerals: noun 96.1%, verb 94.9%, adj 95.2%, adv 92.2%. Only 139 rows aren't WordNet lemmas. The missing ~7,148 are mostly Latin taxonomy (`abies`, `acanthuridae`) plus ~258 orphaned verbs (`adore`, `convene`, `doff`). A diffuse coverage tax, not a structural hole. **The vocabulary was never curated** — treat any rebuild as a deliberate re-selection, not a re-encode of what happens to be in the table.
- **The junk-vocabulary hypothesis is measured and small.** 22.7% of the index is proper nouns, but only **2.8%** of top-10 results are (5 of 7 being case-duplicates of a word already in the same list). `--filter-junk` moved recall **0.0 points**. Kept for the record; not a lever. The predicate lives in one place — `junkPredicate()` in `scripts/lib/retrieval.ts` — and backs both `--filter-junk` (inline) and the `answerable_vocab` **view** created in the database (109,596 of 141,854 rows; excludes capitalised/digit/punctuation lemmas, deliberately **keeps** multi-word ones since `deja vu` and `stiff upper lip` are legitimate answers). A view stores nothing, so it costs no space and is reversible with `DROP VIEW`.
- **Lexical echo is the central phenomenon, and it is structural.** 34.4% of top-10 results share a stem with a query content word (`rain → raininess, rainstorm, raindrop`). Echo results outscore the true target by **+0.134** mean cosine; *non*-echo results outscore it by **+0.094**. The target sits below nearly everything returned, so a reranker over the top 10 has nothing to reorder. Of 17 misses in the 25-query probe, only 2 were approximate-index failures; 15 were true ranking failures.
- **Storage ceiling.** Neon project limit is **512 MB**; `VocabEmbedding` alone is 452 MB (222 MB table + 230 MB indexes) and the database sits at ~460 MB. There is no room for a second index — an attempt to stage one failed with `53100 project size limit exceeded`. pgvector is **0.8.0** and `halfvec` is available: a full gloss index (~206k rows) is ~656 MB as `vector(384)` but ~328 MB as `halfvec(384)`, which fits only if it *replaces* `VocabEmbedding`.

### The eval set — frozen, never regenerated in place

`eval/sets/v1.jsonl`, one object per line: `{ id, query, target, source, meta }`, `source ∈ {authored, gloss_tripwire}`.

- **`authored`** is the real benchmark. Every query was written **blind** — target word plus a one-word sense hint, with no gloss, no `Word.definition`, and no dictionary consulted. `scripts/sample-targets.ts` emits bare words precisely so authoring can't be contaminated by the tooling. **This rule is the only thing that makes the benchmark worth anything against a model fine-tuned on WordNet glosses.**
- **`gloss_tripwire`** is 93 pairs from `Word.definition`, carrying `meta.leakage: "paraphrase"`. Catastrophic-regression detector only — **never a headline number**.
- **Known limitation, state it wherever the set is cited:** authored by a single writer in a single session, so it is single-register even though it is blind, and it is *not* a sample of real user queries.
- `meta.zipf` (raw, from `eval/data/zipf-en.tsv`) is the stored truth; frequency *bands* are derived at analysis time so boundaries can be redrawn without rebuilding. Source is OpenSubtitles 2018 — conversational register, matching how people phrase these queries, but it under-weights literary/technical vocabulary, so "rare" here is not rare in writing.
- `meta.lexical_overlap ∈ {none, stem_shared, head_noun}`. Overlap rows are **kept on purpose** (a person asking about a bowler hat says "hat"); the harness reports recall including and excluding them.
- `meta.reachable: false` rows measure vocabulary coverage and are excluded from headline recall.
- `acceptable[]` enables lenient Recall@1 alongside strict.

**The set is frozen once built. A new version means a new filename — never an in-place regeneration.** `build-eval-set.ts` prints a sha256; record it.

### Running it

```bash
npm run eval                    # baseline: production settings, probes=10
npm run eval:exact              # sequential scan — true nearest-neighbour ceiling
npm run eval:filtered           # with the junk predicate applied
npx tsx scripts/eval.ts --compare eval/runs/a.json eval/runs/b.json
```

Reports Recall@1/@3/@10, MRR@10, strict + lenient recall, **echo rate** (a primary metric — a change that improves recall without moving it needs explaining), and latency p50/p95, sliced by source, style, query length, token count, reachability, `lexical_overlap` and frequency band. Per-query results go to `eval/runs/<tag>.json`. `--compare` is **paired**, using exact two-sided McNemar on rank-1 disagreements, and prints named wins and regressions — comparing two independent Recall@1 figures at n≈300 cannot see a three-point change.

Gotchas that cost real time:
- **Latency here is not production latency.** `db p50 ≈ 466ms` vs `embed p50 ≈ 20ms` is a local-machine-to-Neon round trip; in production both sit in `iad1`. Valid for comparing runs on one machine, not for describing user experience.
- The embedder is warmed before timing; without that, ONNX cold start lands on query #1 and destroys the percentiles.
- `eval/runs/` is gitignored **except** the committed reference baselines. `eval/audit/` and `eval/data/pool-manifest.json` are working artifacts, ignored.

### Phase E — the gloss-index experiment (staged, not yet run)

Testing whether re-indexing *gloss text per sense* (rather than bare lemmas) fixes the echo problem, with no retraining. Run as a 2×2 so a null result can distinguish "glosses don't help" from "the fine-tune can't use them" — the fine-tune was trained `query_to_doc`, so gloss↔gloss matching is off-distribution for it, while the base model is symmetric.

|  | lemma index | gloss index |
|---|---|---|
| `franzclarin/ReverseDictionary` | `eval_lemma_ft` (production repr.) | `eval_gloss_ft` |
| `Xenova/all-MiniLM-L6-v2` (base) | `eval_lemma_base` (did the fine-tune buy anything?) | `eval_gloss_base` |

Plus two gloss-text variants on the base model: `eval_gloss_base_ex` (definition + WordNet's quoted examples) and `eval_gloss_base_lem` (`"<lemma>: <definition>"`). Primary variant is **definition only** — examples are usage sentences about a specific referent, and the lemma prefix reintroduces exactly the echo being removed.

- **Cells live in local files, not Postgres** (`scripts/lib/localIndex.ts`, default `C:/Temp/rd_eval_cells`, override `EVAL_CELL_DIR`). Forced by the 512 MB ceiling, but better anyway: zero database writes, and a brute-force scan of the 20k pool is **exact by construction**, so the 2×2 isolates representation from index error. Kept outside the repo because the working tree is in OneDrive. Search with `eval.ts --index-file <cell>`; `--index <table>` still works for Postgres-resident indexes.
- **Pools are matched**: 287 targets + 20,000 distractors = 20,287 words, restricted to `VocabEmbedding ∩ (has a WordNet gloss)` so no cell can win on coverage. Verified identical across all six cells. Absolute recall on a 20k pool is *not* comparable to production; only the relative comparison across cells is valid.
- **The production build would differ**: full WordNet lemma set, which repairs the ~5% coverage gap for free. Keep the two distinct and say which is which in run metadata.
- Rebuild with `scripts/build-eval-pool.ts` then `scripts/embed-eval-pool.ts --cell <name>` (~35 min for all six). `scripts/verify-eval-pool.ts` checks pool identity and self-retrieval; **lemma cells must score 60/60 at rank 1, and gloss cells 59-60/60 at rank 1 by SYNSET** — not by lemma. A synset's words share one gloss, so their vectors are bit-identical and rank 1 among them is an arbitrary tie-break; the exact-lemma rate (32/60 at full scale) measures tie-breaking, not integrity. Gloss cells are 59/60 rather than 60/60 because 482 gloss texts are shared by more than one synset (1,216 synsets, 1.1% of the index), and those are genuinely indistinguishable; ~0.65 such collisions are expected in 60 probes.

### Pre-registered prediction — recorded before the numbers, do not retrofit

258 orphaned verbs out of 11,540 is 2.2% of the verb inventory: too small to move a whole style slice. **If `narrative` recall lands materially below the other styles, orphaned verbs are almost certainly not the explanation and the finding points back at the representation.** This string is printed by every run and stored in every `eval/runs/*.json` as `preregistered`.

### The frozen set

`eval/sets/v1.jsonl` — **sha256 `cc03e1347ff696fb253c92dfb8b9e7455c64b2122f711ed5c288f33b06c0ccc8`**, built 2026-08-19 from the reviewed `v1-draft.tsv`. 405 rows: 312 authored (287 reachable + 25 coverage) and 93 `gloss_tripwire`. 133 authored rows carry `acceptable[]`.

**Never regenerate `v1.jsonl` in place.** It is frozen; a new version means a new filename. Every run records the set's sha256 in its config, and `report.ts` recomputes it from disk and shouts if they diverge — an in-place edit is otherwise silent and invalidates every number already recorded.

**Known limitation of v1:** only 133/312 rows have `acceptable[]`, so on the other 179 lenient R@1 equals strict R@1 and the synonym-tie correction is only partial. Deliberate MVP scope, not a bug. See METHODS §8.6; the unresolved candidates are in `eval/audit/acceptable-recommendations.tsv`.

### Headline results (v1, corrected 2026-08-20)

Authored slice, 287 reachable queries. **Lenient R@1 is the metric the decision rule resolves on** (METHODS §9a).

**These numbers supersede the 2026-08-19 set, which was contaminated.** The pool emitted `[...targets, ...distractors]`, putting all 287 eval targets in the first 685 rows of every cell, and `searchLocal` broke ties on row order — so a target won every synset tie it was in. That inflated gloss cells by up to 8.9 points of strict R@1 and left the tie-free lemma cells untouched, biasing the exact comparison §9a resolves on. Both causes are fixed in the pipeline (METHODS §12); every cell below was re-embedded from the clean pool.

| cell | lenient R@1 | strict R@1 | R@10 | MRR@10 | echo |
|---|---|---|---|---|---|
| `baseline` (production, probes=10) | 10.1% | 5.6% | 26.1% | 0.109 | 40.7% |
| `exact` (sequential scan) | 10.5% | 5.9% | 30.0% | 0.119 | 44.3% |
| `cell_lemma_ft` (production repr.) | 10.5% | 5.9% | 30.3% | 0.120 | 44.3% |
| `cell_lemma_base` | 5.9% | 2.8% | 15.7% | 0.060 | 58.9% |
| `cell_gloss_ft` (per-sense) | 23.3% | 19.2% | 51.6% | 0.281 | 14.2% |
| `cell_gloss_base` (per-sense) | 21.6% | 16.7% | 43.2% | 0.240 | 16.0% |
| **`cell_gloss_ft_synset`** (production variant) | **25.8%** | 22.0% | 51.2% | 0.305 | 14.4% |
| `cell_gloss_ft_synset_h384` | 25.8% | 22.0% | 51.2% | 0.305 | 14.4% |
| `cell_gloss_ft_synset_h256` | 24.0% | 20.6% | 51.9% | 0.294 | 14.4% |
| `cell_gloss_base_synset` | 22.3% | 18.1% | 43.6% | 0.252 | 16.0% |

- **Gloss indexing wins, and survived the correction.** `lemma_ft → gloss_ft` is **+12.9 points** lenient R@1 (53 wins / 16 regressions, p < 0.0001) and `lemma_base → gloss_base` is **+15.7** (57/12, p < 0.0001) — still roughly twice the pre-committed ~6-point bar. **Echo falls 44.3% → 14.2%**: recall and echo move together, which is what a real representation fix should do.
- **The fine-tune is worth little.** `lemma_base → lemma_ft` is +4.5 points, *below* the threshold, so it stands as a **null result** despite p = 0.029. Swapping the index beats retraining by roughly threefold.
- **Synset-keyed collapse is lossless.** With the tie order held constant it is per-query identical to per-sense: 287/287 identical top-10 order, 0 discordant rank-1 pairs. 204,549 gloss rows collapse to 114,662 (43.9%, 0 divergent). The earlier "⚠ cross-surface" caveat was **measured and falsified** — synset mates already occupy one tied block in a per-sense cell, so expansion spends no slots that cell was not already spending.
- **`halfvec(384)` is free**: 0 discordant pairs, every headline digit identical, `cos(before, after)` mean 0.99999998. **`halfvec(256)` is not** — that is *truncation*, not quantization, and neither model is Matryoshka-trained; it costs 1.7 points and leaves only 17/287 queries with the same top-10.
- **The tie-break is worth points.** `--expansion-order wordnet` scores 25.8% against alphabetical's 23.3% *on identical vectors*. Real, but cite the caveat: picking it because it scored best here is mild benchmark-fitting; the independent case is that sense familiarity is the right prior when retrieval genuinely cannot separate two synonyms.
- **The approximate index costs ~0.3 points** of lenient R@1 (p = 1.0), and `--filter-junk` moves **0.0** — both controls confirmed on real data.
- **Cross-validated:** `exact` (pgvector) vs `cell_lemma_ft` (local brute force) agree at **R@1 delta 0.00 points, top-1 agreement 99.0%**.
- Pre-registered prediction: narrative recall was **not** materially below the other styles, so its conditional never fired.
- **The fine-tune's original 10.9% training-time figure is unusable and must not be cited** — measured with no held-out split, so it describes memorisation, not retrieval.

### Next steps

- Production build of a **synset-keyed gloss index** at `halfvec(384)`: 114,662 rows, ~88 MB of vector payload. Dropping `VocabEmbedding`'s IVFFlat index frees 230 MB, which is what makes it fit under the 512 MB ceiling while keeping the bare vectors as an exact-search rollback.
- `halfvec` recall cost is **settled: zero at 384 dimensions.** Do not use `halfvec(256)`.
- Open: whether a cutover is acceptable, to be decided on shadow-log agreement over real traffic rather than on 287 hand-authored queries.

## Commands

```bash
npm run dev            # local dev
npm run build          # prod build
npm run lint
npx tsc --noEmit       # type-check (run before committing)

npm run eval           # offline retrieval eval against eval/sets/v1.jsonl
npm run eval:exact     # nearest-neighbour ceiling (sequential scan)
npm run eval:filtered  # with junk-vocabulary filter
npm run eval:report    # regenerate eval/REPORT.md from eval/runs/*.json

# a Phase E cell (local file-backed index; encoder follows the cell's model)
npx tsx scripts/eval.ts --set eval/sets/v1.jsonl --tag cell_gloss_ft --index-file eval_gloss_ft --per-sense
```

## Repo hygiene

- Platform: Windows / PowerShell. `_model_tmp/` and `reverse_dict_model.zip` are gitignored (large model/seed artifacts).
- **Deploy by pushing to `main`** — the Git integration clones the repo, so `.gitignore` applies and the build is correct. `vercel deploy --prod` **fails**: the CLI uploads the working directory instead, sweeping in `reverse_dict_model.zip` and `_model_tmp/` (~1.5GB) and blowing the 100MB per-file cap. `.gitignore` does not apply to CLI deploys — only `.vercelignore` does, and there isn't one.
- The repo lives under OneDrive. Its placeholder files make Next's startup cleanup of `.next` fail with `EINVAL: readlink …`, and `next dev` then **exits 0 without serving**. If dev dies instantly, `rm -rf .next` and restart.
- ESLint config is `.eslintrc.json` (`next/core-web-vitals`). Without it `npm run lint` drops into an interactive setup wizard and hangs non-interactive shells.
- **Committed eval artifacts:** `eval/data/zipf-en.tsv` (1.7 MB), `eval/sets/*.tsv|jsonl`, and the reference `eval/runs/baseline.json`. Ignored: the rest of `eval/runs/`, `eval/audit/`, `eval/data/pool-manifest.json`. Vector cells (~230 MB) live outside the repo entirely — see `EVAL_CELL_DIR`.
- **Don't pipe a loop's command through `tail`/`head` when you care whether it worked.** The pipeline reports the exit status of the *last* stage, so six consecutive failures reported success and wasted a 37-minute run. Check status per iteration, or use `PIPESTATUS`.
- Other docs: `ARCHITECTURE.md`, `DEPLOYMENT.md`, `GETTING_STARTED.md`, `SETUP.md`, `README.md`.
