# CLAUDE.md

Guidance for working in this repo. Keep this file current when architecture or workflows change.

## What this is

A **reverse dictionary** web app: the user describes a concept ("the smell of rain on dry earth") and gets the word. Retrieval is powered by a **fine-tuned sentence-embedding model** over a ~522k-word vocabulary — WordNet 3.0 plus a filtered Wiktionary supplement (RD-17) — with semantic search via pgvector.

## Stack

- **Next.js 14** (App Router, TypeScript) + **Tailwind CSS**
- **Neon Postgres** + **Prisma 5** — `pgvector` extension for embeddings
- **No auth, no rate limiting.** Clerk and Upstash Redis/Ratelimit were removed entirely (RD-06, 2026-08-26) — the app has no userbase (no sign-in, saved words, credits, or leaderboard) and `/api/lookup` is fully anonymous and unthrottled. There is no `@clerk/nextjs`, `@upstash/ratelimit`, or `@upstash/redis` dependency and no `middleware.ts`.
- **@xenova/transformers** (Transformers.js) — in-function ONNX embedding
- **No generative AI dependency.** Claude was removed entirely on 2026-08-18 — search never used it, and word pages no longer do (see "Word pages"). There is no `@anthropic-ai/sdk` and no `ANTHROPIC_API_KEY`
- **Sound effects are synthesized, not audio files.** `context/SoundContext.tsx` generates every effect at call time via the Web Audio API (oscillators + filtered noise bursts) — no `public/` audio assets, no dependency. Themed to the paper/typewriter motif: a key click while typing, a carriage-return ding on submit, a stamp thud when results land, a soft two-note tone on errors/no-matches, a neutral click for secondary actions (load more, copy link). Preference persists to `localStorage` (`rd-sound-enabled`, default on); toggle lives in `Navbar`. `AudioContext` is a module-level singleton, not React state — browsers cap how many can exist per page and it must survive remounts.
- Deployed on **Vercel** (region `iad1`); GitHub `franzclarin/Reverse-Dictionary`, branch `main`
- **Dev-only, evaluation tooling:** `tsx` (runs `scripts/*.ts`) and `wordnet-db` (build-time WordNet 3.0 gloss/coverage data). Neither is imported by the app, and `wordnet-db` never touches `eval/sets/` — the eval set is hand-authored and stays blind to every gloss. See "Evaluation".

## How search works (the core flow)

1. `app/page.tsx` `handleSearch()` only routes to `/search?q=…`; **`components/SearchResults.tsx` owns the POST to `/api/lookup`**, so a query typed on the landing page and one re-run from the results bar go through exactly one code path. **No Claude fallback** — errors surface directly (with the server's `detail`).
2. `app/api/lookup/route.ts`:
   - `embed(query)` (`lib/embedder.ts`) → 384-dim L2-normalised vector.
   - `searchGloss()` (`lib/glossSearch.ts`) — pgvector query over **`GlossEmbedding`** (693,325 senses since RD-17: 117,791 WordNet synsets + 575,534 Wiktionary senses) inside a `$transaction` with `SET LOCAL ivfflat.probes`:
     `ORDER BY embedding <=> $1::halfvec LIMIT $2`, similarity = `1 - (embedding <=> …)`.
   - The rows that come back are **senses, not words**. `expandSynsets()` unpacks each into its member `lemmas` (WordNet's own within-synset order — never sort it), dedupes by word across senses, and truncates to `k`. Each word inherits its sense's similarity. A Wiktionary row has exactly one lemma, so expansion is a no-op for it; only WordNet synsets have mates.
   - Returns `{ results: [{ word, similarity }] }` — the API contract is unchanged from the lemma era, so the frontend needed no change.
3. UI navigates to `/word/[top.word]` with runners-up as `?alternatives=`.

**The cutover (RD-02, 2026-08-27).** Search ran over bare lemmas in `VocabEmbedding` until this point; the switch to gloss text per synset is the fix for lexical echo described under "Established facts". `VocabEmbedding` stays populated and indexed as the rollback path — reverting the one `searchGloss()` call in the route is the entire rollback, no data migration. `lib/wordData.ts` (`getRelatedWords`) still reads `VocabEmbedding` **for neighbours** and was deliberately not switched: it finds neighbours of a *word*, which is what a lemma index is actually good at. It no longer reads it to decide whether a word *exists* — see "Word pages"; that mismatch 404'd 8,005 answerable words until RD-17.

**`probes = 40`, not 10.** The lemma index's tuning does not transfer — see `GLOSS_PROBES` in `lib/glossSearch.ts` for the measured sweep. Assuming it did cost 5.5 points of lenient R@1.

## Embedding model — important context

- `lib/embedder.ts` loads ONNX model **`franzclarin/ReverseDictionary`** via Transformers.js with `{ quantized: false }` (uses `onnx/model.onnx`), then `{ pooling: "mean", normalize: true }`. This reproduces the sentence-transformers pipeline (Transformer → mean Pooling → Normalize) that seeded the DB, so query vectors match stored vectors.
- **The model ships INSIDE the function bundle; it is never downloaded at request time (RD-11, 2026-08-27).** `scripts/fetch-model.mjs` downloads the 4 required files (`config.json`, `tokenizer.json`, `tokenizer_config.json`, `onnx/model.onnx`) into `models/franzclarin/ReverseDictionary/` during `npm run build`, and `next.config.js`'s `outputFileTracingIncludes` traces `models/**` into the `/api/lookup` function. Measured: **43,050ms → 64ms** to load, query vectors bit-identical. Cold start used to be **99.8% network** (86MB from the HF CDN) and 0.2% ONNX init — so neither a smaller model nor a keep-warm cron was the fix.
- **`models/` is gitignored and must be fetched once locally: `npm run fetch-model`.** Eight files import `lib/embedder`, so `npm run eval` fails on a fresh clone until you do. The thrown error names the command.
- **`env` is a process-wide singleton — configure it at the call site, never at module scope.** `lib/embedder.ts` needs local-only (`allowLocalModels`, `allowRemoteModels = false`) while `scripts/lib/embedModel.ts` needs remote (base models for the eval cells). Both set it at module scope originally, and whichever module body evaluated last silently won — that broke `eval:prod` with "both local and remote models are disabled". Each now sets what it needs immediately before its `pipeline()` call. **`scripts/lib/reranker.ts` (RD-12) is a third consumer** and follows the same rule; it also needs remote. Three consumers make this failure more likely, not less — a fourth must configure at its own call site too, and if loads ever stop being sequential and awaited this needs a lock rather than a call-site assignment.
- **`env.localModelPath` defaults relative to the Transformers.js module directory, NOT `process.cwd()`** (`@xenova/transformers/src/env.js:52-53`), so it must be set explicitly. The on-disk layout must mirror the repo id: `<localModelPath>/<org>/<name>/...`.
- **There is no quantized model.** `onnx/model_quantized.onnx` returns a 15-byte `Entry not found` from HF — `{ quantized: false }` is the only artifact that exists, not a tuning choice. Producing one would change query vectors and needs a full `eval:prod` behind it.
- Singleton via `globalThis._embedderPromise`. Route sets `runtime = "nodejs"`, `maxDuration = 60` — kept as a safety ceiling, not because the model is slow to load any more.
- `next.config.js` has `serverComponentsExternalPackages: ["@xenova/transformers"]` so the native ONNX runtime isn't webpack-bundled.
- **Do NOT switch to the HF serverless Inference API.** The free `hf-inference` provider returns `"Model not supported by provider hf-inference"` for this custom model regardless of metadata. A paid HF Inference Endpoint would work; the project deliberately uses free in-function embedding instead.
- Original model artifacts: `reverse_dict_model.zip` (gitignored, repo root) contains the full sentence-transformers model incl. `model.safetensors`.

## Word pages — no generative API

`/word/[word]` is powered **entirely by the embedding model**; there is no Claude call anywhere in the flow.

- An embedding model has no decoder, so it **cannot** produce a definition, etymology, pronunciation, or examples. Don't try to restore those from it.
- **Existence is decided by `GlossEmbedding`, neighbours by `VocabEmbedding` (RD-17, 2026-08-28).** These were both `VocabEmbedding` until RD-17, and that was a live bug: search has answered out of the gloss index since the RD-02 cutover, the two tables' lemma sets differed by **8,005 words** when this was found, and `getWordData()` 404'd every one of them. `/word/capsize` returned 404 while search happily returned `capsize`. The same ticket's expansion took that gap to **379,633**, so it had to be fixed in the same change. Whatever search can return must render.
- `getRelatedWords()` (`lib/wordData.ts`) is the core of the page: nearest neighbours by cosine distance over `VocabEmbedding`, reading the word's **stored** vector via a subquery, so it never loads ONNX — pure pgvector, fast. Words with no lemma vector fall back to a **sense** neighbourhood over `GlossEmbedding`, expanded with the same `expandSynsets()` the search path uses. The lemma path is untouched, so no page that worked before RD-17 changed behaviour.
  - The gloss fallback's subquery is `WITH q AS MATERIALIZED`. Spelled inline twice like the lemma path's, Postgres re-plans the GIN lookup for both the SELECT and the ORDER BY: measured **1533ms → 719ms**.
  - Backed by `GlossEmbedding_lemmas_gin_idx` (migration `20260828000000_gloss_lemma_lookup`). Without it the existence check is a seq scan over 117,791 rows on every render.
- **A word with no vector has no neighbours, and the code now says so.** 47 of the 475 `Word` rows are Claude-era profiles with no vector in *either* table (`petrichor` is one — real definition, in no index). `embedding <=> (SELECT … WHERE word = $1)` against a subquery matching nothing is not an error in Postgres: the subquery is NULL, every distance is NULL, and the page rendered **twelve arbitrary rows presented as semantic neighbours**. Pre-existing, not introduced by the two-table split; fixed by checking for a vector before querying.
- `getWordData()` returns an existing `Word` row if present (words profiled before Claude was removed keep their definition — reading them is free), otherwise creates a **minimal row with empty text fields** so the word has a stable id and URL. The page renders around whatever is empty.
- **Gotcha:** those minimal rows are indistinguishable from a real profile by presence alone. If a generative source is ever added back, regenerate on `definition === ""`, not on row-absence, or every word visited during this era will stay blank forever.
- Both `getWordData` and `getRelatedWords` are wrapped in React `cache()` so the page and `generateMetadata` share one query per request instead of duplicating it.
- `app/word/[word]/error.tsx` is the boundary that keeps a server-side exception from surfacing as Next's bare "Application error … Digest: …".
- **Known cosmetic issue:** with `dynamic = "force-dynamic"`, `notFound()` renders the correct 404 page but the HTTP status is already committed as 200. Pre-existing; matters only for SEO.

## The `/explain` page (RD-18)

`/explain` shows the retrieval pipeline running on a phrase you type: WordPiece
tokens, one real 384-d vector per token, those vectors averaging into one, and
the nearest senses lighting up in a projected cloud. **It moves no metric and
ships nothing into the search path** — judge it on whether someone with no ML
background comes away understanding [echo](backlog/glossary.html).

- **Everything numeric on it is real.** It calls the same `/api/lookup` with
  `debug: true`, so scores come from the live 117,791-synset index through the
  served code path. There is no second retrieval implementation to drift.
- **Two gated seams, both off by default.** `searchGlossSynsets()` takes
  `{ withGloss, withVector }`; with both off it emits **character-identical SQL**
  to the pre-RD-12 query. `/api/lookup` takes `debug: true`, which adds a `debug`
  key and changes nothing else. `k` is now validated (1…100) — it used to flow
  unbounded into `LIMIT`.
- **`embedTokens()` (`lib/embedder.ts`) is the animation's honesty.** One
  `pooling: "none"` forward pass returns `last_hidden_state`; mean-then-normalise
  reproduces `embed()` exactly, because Transformers.js's `mean_pooling()` is a
  plain attention-masked mean. So the film averages the encoder's **actual**
  token vectors rather than something synthesised to look like activity. The
  serving path still calls `embed()`, untouched.
- **The browser never loads the model.** `lib/viz/wordpiece.ts` reimplements
  BERT WordPiece from `public/viz/wordpiece.json` (the 30,522-piece vocabulary,
  293 KB) rather than importing `@xenova/transformers` into the client, which
  would have dragged ~1 MB of JS and the onnxruntime-web loader into a page
  whose whole point is that the 86 MB ONNX file stays on the server. `/explain`
  first-load JS is **102 kB**.
- **A reimplementation is only honest if it is checked**, so `npm run verify-viz`
  asserts it against the real `AutoTokenizer` over every query in the frozen eval
  set plus deliberately awkward strings (accents, OOV, CJK, truncation) — 415/415
  identical. It caught a genuine quirk worth keeping: **an over-long input loses
  its `[SEP]`**, because truncation happens *after* post-processing appends it.
- **PCA, and the reason is not aesthetics.** `scripts/build-viz-snapshot.ts` fits
  a fixed 384×3 basis offline, so a synset the fit never saw still has an exact
  place and the layout does not move between queries. Measured: **three
  components carry 11.9% of the variance**, which is printed on the page. UMAP
  and t-SNE were rejected because a live query would have no honest position.
- **`/explain` must never get an `outputFileTracingIncludes` entry.** It renders
  from `public/viz/` and calls the API; verified traced at 20 files, none of them
  model or ONNX.
- Canvas 2D, not `three` — 6,200 points with an orbit camera and a painter's-algorithm
  depth sort did not justify a rendering dependency in a repo with five.
  `components/explain/PointCloud.tsx` writes the query's screen position into a
  **ref** each frame so `TransformFilm.tsx` can fly the vector into the cloud;
  routing 60fps through React state would re-render the page for nothing.
- The steps card hides and restores (`localStorage`, `rd-explain-steps-open`).
  **The four approximation labels along the bottom deliberately do not hide with
  it** — a control that tucked the caveats away while the persuasive picture kept
  running would invert the reason they exist.

## Data model (`prisma/schema.prisma`)

Models: `Word`, `VocabEmbedding`, `GlossEmbedding`, `ShadowLookup`.
- `VocabEmbedding { id, word @unique, embedding Unsupported("vector(384)") }` — 141,854 rows, IVFFlat index (`vector_cosine_ops`, `lists = 150`).
- pgvector columns use `Unsupported("vector(384)")`; query them with `$queryRawUnsafe` and a `[..]` vector literal, never the typed Prisma client.
- **`SavedWord`, `User`, `Lookup`, `GameRound` were removed entirely (RD-06, 2026-08-26)** along with Clerk auth and the credits/games system built on them. `Word.savedBy` went with `SavedWord`. None of the removed models had any relation to `VocabEmbedding`/`GlossEmbedding`/`ShadowLookup`, so the search path was untouched.

## API routes (`app/api/`)

- `lookup/` — embedding search (primary). No auth, no rate limiting.
- `word/[word]/` — word page data.

## Conventions & gotchas

- **Read `response.json()` defensively**: parse in a try/catch, THEN check `response.ok`. An empty body (Vercel gateway 401/502, crashed function) otherwise throws "Unexpected end of JSON input". Both search routes and the client already do this.
- **"fetch failed" is never the real error.** Node/undici throws a bare `TypeError: fetch failed` for every network fault and hides the reason on `error.cause` (`code`, `errno`, `hostname`) — sometimes nested, sometimes inside an `AggregateError.errors`. Never log or return `err.message` alone. Use `describeError()` / `formatErrorShape()` from `lib/errors.ts`, which flatten the whole cause chain.
- **Tag failures by subsystem.** `/api/lookup` has two outbound dependencies that can each produce an identical "fetch failed". Wrap each and throw `SubsystemError(subsystem, …)` so the log line (`[lookup] FAILED subsystem=…`) and the client's `detail` name the culprit:
  - `model` — loading `franzclarin/ReverseDictionary` from the bundled `models/` directory. Since RD-11 there is **no network** in this path, so this now means a missing/corrupt file (locally: run `npm run fetch-model`; on a deploy: `outputFileTracingIncludes` stopped matching), not a CDN fault.
  - `database` — the pgvector query. (Prisma here is **plain TCP**, not `@prisma/adapter-neon` / `@neondatabase/serverless`, so it does *not* use fetch. It only appears as "fetch failed" if someone swaps in a fetch-based driver.)
- **Never cache a rejected promise.** `globalThis._embedderPromise` memoises the model load. If a rejected promise stays in that slot, every later request on the same warm instance fails instantly with the same stale error forever, even after the network heals. `getEmbedder()` clears the slot on rejection (guarded by identity check); `loadEmbedder()` retries 3× with exponential backoff and bails early on non-network errors so it doesn't burn the 60s budget.
- Observed cause codes: `ENOTFOUND` (bad/stale host), `ECONNREFUSED` (host up, nothing listening), plus `EAI_AGAIN` / `UND_ERR_CONNECT_TIMEOUT` for DNS and CDN stalls.
- The error `detail` returned to the client includes `subsystem` + `code`, but **`hostname` only outside production** (a database host can identify a private DB). The full shape is always in the server logs.
- **The retrieval transaction waits for Neon to wake up.** `searchGlossSynsets()` passes `{ maxWait: 15s, timeout: 20s }` to `$transaction`. Prisma's 2s default is shorter than Neon's compute wake-up, so the first query after an idle period died with `P2028 Unable to start a transaction in the given time` — a 500 for the user with nothing wrong with the query. The eval harness works around the same thing by warming the database first; a route cannot warm anything, so it waits. Both values sit well inside the route's `maxDuration = 60`.
- Migrations: Neon pooled connections break `prisma migrate deploy`'s advisory lock — apply SQL via `prisma db execute --file` instead.
- **An IVFFlat rebuild needs `SET maintenance_work_mem` in the migration file.** Neon's default is 64 MB; the build over 693,325 `halfvec(384)` rows at `lists = 833` needs 169 MB and fails outright with `memory required is 169 MB, maintenance_work_mem is 64 MB`. `prisma db execute --file` runs the whole file as one transaction, so a failed `CREATE INDEX` rolls its `DROP INDEX` back with it and the serving index survives — the failure is safe to retry, not a window of unindexed production. Verified by checking `pg_indexes` after the first attempt failed.
- **`lists` and `probes` are one setting with two halves.** A probe scans roughly `rows / lists` candidates, so changing the row count changes what a given `probes` value *means*. RD-17 grew the table 5.9× and re-swept both; never move one without the other.
- Env: local `.env.local` needs only `DATABASE_URL` (Neon owner role). No Clerk or Upstash keys required anymore.

## Evaluation (`scripts/`, `eval/`) — additive tooling, read-only

Offline harness measuring the real retrieval path (`embed(query)` → pgvector top-k) against a frozen set of (description → word) pairs. Built because the fine-tune was scored in Colab against in-batch negatives, while production ranks against 141,854 candidates through an approximate index — different problems that can disagree.

**Rules that keep it honest.** Read-only against the database. The app is never modified: `scripts/lib/retrieval.ts` *mirrors* `app/api/lookup/route.ts` (same `$transaction`, same `SET LOCAL ivfflat.probes`, same `<=>` ordering) and `eval.ts` imports `embed` from `lib/embedder.ts` rather than reimplementing it. A second embedding path would make every number fiction. Dev-only deps: `tsx`, `wordnet-db` (build-time gloss/coverage data, never imported by the app).

### Established facts — verified, do not re-derive

- **The WordNet training corpus is unsplit and unusable for evaluation.** The model card inside `reverse_dict_model.zip` (`sentence_model/README.md`) records 181,149 (gloss, lemma, negative-lemma) triplets, `MultipleNegativesRankingLoss`, **3 epochs, no evaluator, no held-out split** (`eval_on_start: False`, `prediction_loss_only: True`). Its sample rows are verbatim WordNet glosses. Any WordNet-gloss-derived eval slice is ~100% leaked. This is why the eval set is hand-authored.
- **`VocabEmbedding` stores bare-lemma embeddings.** `cos(embed(word), stored[word]) = 1.000000 ± 1e-6` across 24 probe words (`scripts/probe-representation.ts`). Corroborated structurally: `vocab.index` is 217,887,789 bytes = 141,854 × 384 × 4 + 45. Search matches a 12-word description against a 1-token document. This is *consistent with* training (`directions: ["query_to_doc"]`), so it is not a train/serve mismatch — the fine-tune simply did not achieve its own objective.
- **Paired-test counts recorded before 2026-08-28 were computed over all 405 rows, not the 287-row headline slice.** `--compare` scored its McNemar over every paired row in the file — including the 93 quarantined `gloss_tripwire` rows and the 25 unreachable ones — while every recall figure beside it was the authored-reachable slice. It also tested **strict** rank-1 only, though §9a has resolved on **lenient** since the amendment. Both fixed in RD-12. **No recorded verdict changes**, but the counts do: the RD-02 cutover's "64 wins / 17 regressions" was strict-over-405; lenient on the headline slice is **55 / 15**, and the delta the fixed tool computes (+13.9pp) now reproduces the figure the docs already carried. Phase E's cell comparisons (METHODS §12) carry counts from the old scope and their cells no longer exist to re-derive — read those `(53/16)`-style pairs as all-rows-strict, and re-derive rather than cite them if they ever matter again.
- **No query text has ever been logged.** Before RD-06 removed them, `Lookup` was `{id, userId, createdAt}` — a rate-limit counter — and `GameRound` was the credits casino (`coinflip`, `slots`, …), not a word game; neither ever stored query text. There is no sample of real user queries to draw on, and the eval set cannot pretend to be one.
- **`VocabEmbedding` ⊂ WordNet 3.0, ~95% of it, with no POS skew.** Presence excluding numerals: noun 96.1%, verb 94.9%, adj 95.2%, adv 92.2%. Only 139 rows aren't WordNet lemmas. The missing ~7,148 are mostly Latin taxonomy (`abies`, `acanthuridae`) plus ~258 orphaned verbs (`adore`, `convene`, `doff`). A diffuse coverage tax, not a structural hole. **The vocabulary was never curated** — treat any rebuild as a deliberate re-selection, not a re-encode of what happens to be in the table.
- **The junk-vocabulary hypothesis is measured and small.** 22.7% of the index is proper nouns, but only **2.8%** of top-10 results are (5 of 7 being case-duplicates of a word already in the same list). `--filter-junk` moved recall **0.0 points**. Kept for the record; not a lever. The predicate lives in one place — `junkPredicate()` in `scripts/lib/retrieval.ts` — and backs both `--filter-junk` (inline) and the `answerable_vocab` **view** created in the database (109,596 of 141,854 rows; excludes capitalised/digit/punctuation lemmas, deliberately **keeps** multi-word ones since `deja vu` and `stiff upper lip` are legitimate answers). A view stores nothing, so it costs no space and is reversible with `DROP VIEW`.
- **Lexical echo is the central phenomenon, and it is structural.** 34.4% of top-10 results share a stem with a query content word (`rain → raininess, rainstorm, raindrop`). Echo results outscore the true target by **+0.134** mean cosine; *non*-echo results outscore it by **+0.094**. The target sits below nearly everything returned, so a reranker over the top 10 has nothing to reorder. Of 17 misses in the 25-query probe, only 2 were approximate-index failures; 15 were true ranking failures. **⚠ The reranker clause is SUPERSEDED for the gloss index (2026-08-27, RD-12) — it describes the lemma index only, which is now the rollback path.** On the live `GlossEmbedding` index the target is inside the top 100 for **77.0%** of authored reachable queries but at rank 1 for only **24.0%** (ranks 2–10: 27.9%, ranks 11–100: 25.1%, never retrieved: 23.0%) — so there is 53 points of lenient R@1 sitting in the shortlist, waiting to be reordered. Recompute from `eval/runs/prod_gloss_shipped.json`; the harness already retrieves to `--rank-depth 100`, so every committed run since the cutover carries this number. The echo/margin measurements in the rest of this bullet stand as written for the lemma index.
- **That headroom is real, and off-the-shelf reranking does not reach it (RD-12, 2026-08-28 — measured and rejected).** Do not re-run this experiment without reading METHODS §13. Three arms of `ms-marco-MiniLM` cross-encoders over the gloss shortlist, depth swept 10/25/50/100, all scored **below plain retrieval** on lenient R@1 (best 24.4% against 24.0%; paired deltas −3.8/−2.4/−2.1pp, every one negative). Recall *falls* as shortlist depth rises, and the `"<lemma>: <definition>"` input variant recovers ground only by driving **echo from 14.5% to 21.4%** — Phase E predicted exactly that, and RD-12 measured it rather than assuming it. The cause is visible in the scores: MS MARCO trains web-passage relevance, so the model ranks glosses by term overlap with the query, which is *echo relocated into the reranker*. A query is a **description** and a gloss is a **definition** — related by paraphrase, not overlap. Parameter-free rank fusion (the control, `scripts/probe-rerank-fusion.ts`) tops out at **25.8%, +1.8pp**, which is a null result under §9a and additionally the maximum of 24 post-hoc cells. **The 53pp remains unclaimed**; a fine-tuned reranker is a separate decision to be made against these numbers, not against the ceiling.
- **The register gap is closed, and it was RD-14's whole premise (RD-16, 2026-08-28).** METHODS §4 recorded a "~43-point register gap" — dictionary-phrased queries beating hand-written ones — and §9a cites it as the effect size that justifies a representation change. It is a **lemma-index** fact. Scoring the leaked `gloss_tripwire` slice beside the blind authored slice inside the same run: the gap at R@10 went **+26.1pp → +1.8pp** and at rank 1 **+9.3pp → −0.4pp**. Conditioned on the target being retrievable at all the register-matched slice is now the *worse* of the two (−3.7pp), because its targets are the easier ones (86.0% in the top 100 against 77.0%). **RD-02 closed it for free.** Reproduce with `npx tsx scripts/probe-register-gap.ts`; §4 and §5 are superseded in place; §9a's threshold is deliberately not renegotiated.
- **No off-the-shelf encoder beats the fine-tune, and the QA-pretrained one loses badly (RD-16, 2026-08-28 — measured and rejected).** Six full-scale cells over all 117,791 synsets, exact scan, paired against the fine-tune control at 25.4% lenient R@1. **Every 384-dim alternative lost**: `multi-qa-MiniLM-L6-cos-v1` **−7.0pp** (35/15, p = 0.007 — the only significant result in the sweep), `gte-small` −2.8, `all-MiniLM-L12-v2` −2.4. Enriching the indexed text with WordNet's examples cost −1.4pp and raised echo. The one arm above the control was `all-mpnet-base-v2` at **+2.8pp** — a null result under §9a (p = 0.32, and the maximum of five post-hoc candidates), 768-dim so it cannot fit a `halfvec(384)` column under Neon's ceiling, and too large for RD-11's bundle. **Nothing shipped.** The consequence for retraining: `multi-qa` holds architecture, width and depth fixed and changes only the corpus (181k WordNet triplets → 215M QA pairs), which is RD-09's own ablation run at a scale this project cannot reach — and it made retrieval worse. Full write-up: **METHODS §14**.
- **The vocabulary was expanded, and the arm designed to be safe is the one that failed (RD-17, 2026-08-28 — SHIPPED).** `GlossEmbedding` now holds **693,325 senses**: WordNet's 117,791 synsets plus **575,534 filtered Wiktionary senses** over 443,645 words. Two arms were built as full-scale cells and scored before anything was written. **`wikt_new`** — index a sense only if WordNet cannot already answer with that headword — lost **8.4 points** of lenient R@1 with **24 regressions and zero wins** (p < 0.00001). **`wikt_all`** — every surviving sense, including new senses of words WordNet already covers — came out **flat** (−0.3pp, 23/22, p = 1.00) while taking R@10 from 54.0% to **59.9%** and the coverage slice from **0.0% to 32.0%** at rank 1. The +8.1pp between the arms is the finding: `wikt_new` can only add **distractors** on the reachable slice, so it measures their cost in isolation; `wikt_all` adds the same distractors *plus* **second surfaces for correct answers**, and those pay for them. **Do not reason about added candidates as pure distractors** — that intuition is what made the losing arm look like the cautious one. Full write-up: **METHODS §15**.
- **A coverage fix converts an impossibility into a ranking problem, and no further.** 20 of the 25 coverage rows are now retrieved within 100 and 8 rank first; `doomscrolling`, `gaslighting` and `hangry` are indexed and still not in the top 100. RD-17 buys candidacy, not rank. `corpsing` is unreachable by design — Wiktionary carries it only as an inflected form of the verb `corpse`, which the filter drops, and the eval row has no `acceptable[]`.
- **Echo rose 14.6% → 17.3% and the mechanism is compositional, not a regression in the copied rows.** Added words fill 38.7% of top-10 slots and supply 46.9% of the echo; echo *within* added words is 21.0% against WordNet's 15.0%, because Wiktionary is far richer in transparent derivatives (`paintery`, `pseudopalindrome`). Only 7 of the 23 lost rank-1s were displaced by an echoing word. Reproduce with `npx tsx scripts/probe-supplement-echo.ts`.
- **Open English WordNet is not the answer, and the 25 unreachable rows are really 23 (RD-17).** OEWN 2024 is +5,307 / −1,003 lemmas against PWN 3.0 and covers **2** of the 23 targets; it also re-keys every synset (`oewn-NNNNNNNN-p`, not `pos:offset`), which would orphan every committed run. Measured, recorded, **not adopted** (`npm run probe:oewn`). Separately, `capsize` and `loiter` are flagged `reachable: false` and have been answerable since RD-02 — the set is frozen, so the denominator deliberately stays 287 (`npm run probe:reachability`).
- **The fine-tune is better than its recorded reputation.** "+4.5pp, a null result" is a statement about the gain over *its own base model*, and had been quietly reread as a statement about model quality. Against five modern alternatives at the same width it wins every one, and the only thing that beats it is 5× the parameters for a null-result +2.8pp. Do not cite it as a weak model; cite it as a weak *fine-tuning gain*.
- **QA and web-passage training data is actively harmful on this task, at both pipeline stages.** RD-12 found MS MARCO cross-encoders ranking glosses by term overlap; RD-16 found a QA-pretrained bi-encoder losing 7 points. Different architecture, different stage, one cause: those corpora teach **question-to-answer-passage relevance** and this task needs **description-to-definition paraphrase**. What transfers is the *relation*, not the size or shape of the model. Two independent measurements now say so — treat "model X is trained on more data" as a claim about *which* relation before treating it as a claim about quality.
- **Storage ceiling — the 512 MB figure was stale and wrong in the direction that matters (corrected RD-17, 2026-08-28).** Measured against the live database, not estimated: `SHOW neon.max_cluster_size` returns **16TB** and `pg_database_size` is **673 MB**. The project was upgraded during RD-01 and the ticket recorded the new cap as unverified; nothing re-checked it, so every later sizing decision was made against a ceiling that was both wrong and *lower than current usage*. **Documentation that is wrong and conservative is worse than documentation that is missing** — it produces a confident "this cannot fit" from someone who never runs the query. Storage is no longer a binding constraint on this project; cost and retrieval quality are. Live per-table figures:

  | table | rows | heap | indexes | total | per row |
  |---|---|---|---|---|---|
  | `VocabEmbedding` · `vector(384)` | 141,854 | 222 MB | 230 MB | 451 MB | 3.3 KB |
  | `GlossEmbedding` · `halfvec(384)` | 117,791 | 113 MB | 100 MB | 213 MB | **1.85 KB** |

  pgvector is **0.8.0** and `halfvec` is measured-free (0 discordant pairs, mean cosine 0.99999998). Converting `VocabEmbedding` to `halfvec` would free ~225 MB; with the cap at 16TB that is no longer worth the risk to the rollback path, and RD-17 deliberately did not do it.

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
npm run eval:prod               # PRODUCTION path: gloss index, probes=40
npm run eval                    # the lemma index (now the ROLLBACK path), probes=10
npm run eval:exact              # sequential scan over the lemma index — NN ceiling
npm run eval:filtered           # lemma index with the junk predicate applied
npm run eval:rerank             # RD-12 cross-encoder stage — measured, NOT shipped
npx tsx scripts/eval.ts --compare eval/runs/a.json eval/runs/b.json
```

**`npm run eval` is no longer the production path.** It still targets `VocabEmbedding`, which the RD-02 cutover demoted to the rollback path — kept under that name because the three committed reference runs are named for it and renaming would orphan them. Use `eval:prod` to measure what users actually get. `--probes` now defaults per-index (lemma 10, gloss 40) rather than forcing 10 on everything; every run records the value it actually used.

Reports Recall@1/@3/@10, MRR@10, strict + lenient recall, **echo rate** (a primary metric — a change that improves recall without moving it needs explaining), and latency p50/p95, sliced by source, style, query length, token count, reachability, `lexical_overlap` and frequency band. Since RD-17 the **coverage slice is scored, not just counted** — a count cannot distinguish "indexed" from "indexed and findable", which is the only question a vocabulary change asks. Per-query results go to `eval/runs/<tag>.json`. `--compare` is **paired**, using exact two-sided McNemar on rank-1 disagreements, and prints named wins and regressions — comparing two independent Recall@1 figures at n≈300 cannot see a three-point change.

Gotchas that cost real time:
- **Latency here is not production latency, and RD-20 is the ticket about how badly.** Beyond the round-trip caveat below, the harness warms the database and then runs 405 queries back to back, so it measures a *warm* index over a sustained burst. Production is low-traffic against an auto-suspending compute, so cold is the common case. Server-side `EXPLAIN ANALYZE` on the shipped index: **61ms warm, 2,678ms cold** at `probes=100`. The harness's `dbMs` p95 got *better* when the index grew 5.9×; do not read that as a latency result. `db p50 ≈ 466ms` vs `embed p50 ≈ 20ms` is a local-machine-to-Neon round trip; in production both sit in `iad1`. Valid for comparing runs on one machine, not for describing user experience.
- The embedder is warmed before timing; without that, ONNX cold start lands on query #1 and destroys the percentiles. **The database is warmed for the same reason, and one more besides** (added RD-12): Neon auto-suspends its compute, so the first query of a run pays several seconds of wake-up — `prod_gloss_shipped.json` records `dbMs=6606` on row 1 against a p50 of ~479 — and that wake-up can exceed Prisma's default 2s interactive-transaction `maxWait` and abort the whole run with `P2028 Transaction not found` before a single row is scored.
- **`dbMs` means something different in a rerank run**, and the run config records which (`dbTiming`). A normal Postgres run times a `LIMIT k` query and issues the deep scan separately and untimed; a rerank run issues **one** `LIMIT rankDepth` query and slices it, because the cross-encoder needs the whole shortlist and its gloss text. Latency is not comparable across the two; ranks are.
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

**Production, measured on the real index after the RD-02 cutover (2026-08-27).** The rows above are local brute-force scans of a *matched 20k pool*; these are the live Neon `GlossEmbedding` table (117,791 synsets) through the actual route path, so they are the numbers that describe what users get. Cite these for "how good is search", and the cells above only for representation comparisons.

| run | lenient R@1 | strict R@1 | R@10 | echo | notes |
|---|---|---|---|---|---|
| `baseline` (lemma, probes=10) | 10.1% | 5.6% | 26.1% | 40.7% | the pre-cutover production path |
| `prod_gloss` (probes=10) | 18.5% | 15.7% | 39.4% | 14.8% | gloss index, lemma's probes — **undertuned** |
| `prod_gloss_shipped` (probes=40) | 24.0% | 20.6% | 49.8% | 14.5% | the pre-RD-17 production path |
| `prod_gloss_p100` (probes=100) | 25.4% | 21.6% | 51.6% | 14.6% | +1.4pp for ~6x the scan cost; not worth it at 117k rows |
| **`prod_wikt_shipped`** (693,325 rows, lists=833, probes=100) | **25.1%** | 20.6% | **55.7%** | 17.5% | **what ships** — RD-17 |

**Probes were re-swept for the expanded index (RD-17)** — `lists = 115` was sized for 117,791 rows, and a probe scans roughly `rows / lists`, so the old tuning did not carry:

| probes | lenient R@1 | R@10 | lenient R@100 | db p50 |
|---|---|---|---|---|
| 10 | 25.4% | 51.9% | 78.0% | 579ms |
| 40 | 24.7% | 54.7% | 81.9% | 568ms |
| **100** | **25.1%** | **55.7%** | **83.6%** | 582ms |
| 200 | 25.1% | 55.7% | 83.6% | 687ms |
| *exact ceiling (cell)* | *25.1%* | *55.7%* | — | — |

**100 is the knee and sits exactly on the exact-scan ceiling.** `probes=10` scores 0.3pp higher on R@1 — one query out of 287 — while giving up 3.8 points of R@10; taking it would be fitting the benchmark rather than reading it.

- **The expansion on real infrastructure**: `prod_gloss_shipped → prod_wikt_shipped` is **+1.0 point** lenient R@1 (25 wins / 22 regressions, p = 0.77) — a **null result** on the headline, which is the honest read — while R@10 goes 49.8% → 55.7%, lenient R@100 goes 77.0% → 83.6%, and the coverage slice goes 0.0% → 32.0%. Echo 14.5% → 17.5%, explained under "Established facts".
- **The cutover is confirmed on real infrastructure**: `baseline → prod_gloss_shipped` is **+13.9 points** lenient R@1 (**55 wins / 15 regressions**, p < 0.00001), inside the +12.9–15.7pp band the cells predicted, with **echo 40.7% → 14.5%** and R@10 nearly doubled. Recall and echo moved together, as they did offline.
- **Probes tuning was worth 5.5 points** and nearly free (~20ms of scan). `probes=100` reaches the exact-scan ceiling (~25.8%), confirming the remaining gap to the cells is *index approximation*, not representation — and that 40 sits at the knee.
- **The cells' absolute numbers did not transfer, and were never meant to.** A 20,287-word matched pool is an easier problem than 117,791 live synsets; CLAUDE.md said so before the cutover and the measurement bore it out. Only the *relative* cell comparisons were ever valid.

### Vocabulary expansion (RD-17, 2026-08-28) — SHIPPED

Full-scale cells over the **expanded** candidate set, exact scan, paired McNemar against the WordNet-only control. `rd17_control` is per-query identical to RD-16's `full_gloss_ft` (0 rank differences), which is what licenses reading the arms.

| cell | rows | lenient R@1 | strict | R@10 | MRR | echo | Δ lenient | verdict |
|---|---|---|---|---|---|---|---|---|
| **`rd17_control`** | 117,791 | **25.4%** | 21.6% | 51.6% | 0.304 | 14.6% | — | — |
| `rd17_wikt_new` | 539,456 | 17.1% | 15.0% | 41.5% | 0.221 | 17.6% | **−8.4** | **significant regression** (24/0, p < 0.00001) |
| **`rd17_wikt_all`** | 693,325 | **25.1%** | 20.6% | **55.7%** | 0.307 | 17.3% | −0.3 | **no difference** (23/22, p = 1.00) — **shipped** |

Coverage slice (the 25 `reachable: false` rows), reported separately and **never folded into headline recall**:

| cell | R@1 | R@3 | R@10 | retrieved within 100 |
|---|---|---|---|---|
| `rd17_control` | 0.0% | 0.0% | 0.0% | 0 of 25 |
| `rd17_wikt_all` | **32.0%** | 48.0% | 64.0% | 20 of 25 |

- **The safe-looking arm is the one that failed, 24 regressions to 0 wins.** `wikt_new` indexes a Wiktionary sense only where WordNet cannot already answer, so on the reachable slice its added rows can *only* be distractors — it is the distractor cost measured in isolation, and that cost is −8.4 points. `wikt_all` adds the same distractors plus **second surfaces for correct answers**, and the +8.1pp between the arms is those senses paying for them.
- **Rank 1 is flat and every depth below it improves.** Lenient recall by depth, control → shipped: `3` 39.4→41.8, `10` 54.0→**59.9**, `50` 73.5→**77.0**, `100` 79.8→**83.6**. The never-retrieved share falls 20.2% → 16.4% — the only thing that has moved the slice §13 called unreachable by reordering at any depth.
- **`probes` and `lists` were re-tuned for the new row count** — `lists = 115` was sized for 117,791 rows and means something different over 693,325. See `GLOSS_PROBES` in `lib/glossSearch.ts`.

- **Gloss indexing wins, and survived the correction.** `lemma_ft → gloss_ft` is **+12.9 points** lenient R@1 (53 wins / 16 regressions, p < 0.0001) and `lemma_base → gloss_base` is **+15.7** (57/12, p < 0.0001) — still roughly twice the pre-committed ~6-point bar. **Echo falls 44.3% → 14.2%**: recall and echo move together, which is what a real representation fix should do.
- **The fine-tune is worth little.** `lemma_base → lemma_ft` is +4.5 points, *below* the threshold, so it stands as a **null result** despite p = 0.029. Swapping the index beats retraining by roughly threefold.
- **Synset-keyed collapse is lossless.** With the tie order held constant it is per-query identical to per-sense: 287/287 identical top-10 order, 0 discordant rank-1 pairs. 204,549 gloss rows collapse to 114,662 (43.9%, 0 divergent). The earlier "⚠ cross-surface" caveat was **measured and falsified** — synset mates already occupy one tied block in a per-sense cell, so expansion spends no slots that cell was not already spending.
- **`halfvec(384)` is free**: 0 discordant pairs, every headline digit identical, `cos(before, after)` mean 0.99999998. **`halfvec(256)` is not** — that is *truncation*, not quantization, and neither model is Matryoshka-trained; it costs 1.7 points and leaves only 17/287 queries with the same top-10.
- **The tie-break is worth points.** `--expansion-order wordnet` scores 25.8% against alphabetical's 23.3% *on identical vectors*. Real, but cite the caveat: picking it because it scored best here is mild benchmark-fitting; the independent case is that sense familiarity is the right prior when retrieval genuinely cannot separate two synonyms.
- **The approximate index costs ~0.3 points** of lenient R@1 (p = 1.0), and `--filter-junk` moves **0.0** — both controls confirmed on real data.
- **Cross-validated:** `exact` (pgvector) vs `cell_lemma_ft` (local brute force) agree at **R@1 delta 0.00 points, top-1 agreement 99.0%**.
- Pre-registered prediction: narrative recall was **not** materially below the other styles, so its conditional never fired.
- **The fine-tune's original 10.9% training-time figure is unusable and must not be cited** — measured with no held-out split, so it describes memorisation, not retrieval.

### Reranking (RD-12, 2026-08-28) — measured, rejected, NOT served

`npm run eval:rerank`. A cross-encoder re-sorts the retrieved shortlist before scoring: retrieval stays a bi-encoder over 117,791 synsets, and the slow model only ever sees the top 50–100. Implemented as a stage over the existing retrieval path — `lib/glossSearch.ts` gained `searchGlossSynsets()` so synsets and their gloss text survive to the harness, and `searchGloss()` composes over it unchanged.

**Nothing here ships.** `/api/lookup` is untouched, and the numbers below are offline only — do not cite them as search quality. The production table above still describes what users get.

Lenient R@1, authored reachable (n=287), gloss index at probes=40. **Retrieval alone is 24.0%.**

| arm | d=10 | d=25 | d=50 | d=100 | echo @100 |
|---|---|---|---|---|---|
| **no rerank** | **24.0** | — | — | — | **14.5%** |
| `ms-marco-MiniLM-L-6-v2`, gloss | 21.6 | 19.9 | 20.6 | 20.2 | 15.2% |
| `ms-marco-MiniLM-L-6-v2`, lemma-gloss | 23.3 | 22.6 | 22.3 | 21.6 | 21.4% |
| `ms-marco-MiniLM-L-12-v2`, gloss | 24.4 | 22.6 | 23.0 | 22.0 | 15.0% |

- **Every arm loses**, and the paired tests agree: −3.8pp (22 wins / 33 regressions, p = 0.177), −2.4pp (23/30, p = 0.410), −2.1pp (21/27, p = 0.471). Null results under §9a — none clears the ~6-point bar, and all three point the wrong way.
- **Recall falls as shortlist depth rises**, monotonically. Handing the model more to reorder makes it worse, which is what a near-uninformative ranking looks like.
- **The lemma-gloss variant trades echo for recall.** Echo climbs 16.1 → 18.6 → 20.6 → 21.4% with depth. Echo is a primary metric precisely so this is visible.
- **Fusion is the control, not a rescue.** Parameter-free RRF (`scripts/probe-rerank-fusion.ts`, reads a persisted shortlist — no model, no DB) tops out at 25.8%, **+1.8pp**: a null result, and the maximum of 24 post-hoc cells on a half-`acceptable[]` set. Do not report it as a win.
- **The sweep is free**: a depth-D re-sort is a prefix of the depth-100 scores, so `--rerank-sweep` scores every depth from one run's forward passes.
- **The ceiling is still there.** 77.0% of targets are inside the top 100 and 72.5% inside the top 50 — the opportunity is real and unclaimed. What was falsified is that an off-the-shelf MS MARCO cross-encoder reaches it. Full write-up, the failure mechanism and the worked example: **METHODS §13**.

### Encoder sweep (RD-16, 2026-08-28) — measured, rejected, NOT served

Six **full-scale** cells over all 117,791 WordNet synsets — the first cell family in this project whose absolute recall is comparable to a production run (Phase E's cells are a matched 20k pool and are not). Exact brute-force scan, so no index approximation is mixed in. Built with `scripts/build-encoder-cell.ts`, verified at 59/60 by synset with `scripts/verify-encoder-cell.ts`.

Lenient R@1, authored reachable (n=287), paired McNemar against the control.

| cell | encoder | lenient R@1 | strict | R@10 | MRR@10 | echo | Δ | verdict |
|---|---|---|---|---|---|---|---|---|
| **`full_gloss_ft`** | the fine-tune (**control**) | **25.4** | 21.6 | 51.6 | 0.304 | 14.6% | — | — |
| `full_gloss_mpnet` | `all-mpnet-base-v2` (768d, 110M) | 28.2 | 23.0 | 53.0 | 0.314 | 13.8% | +2.8 | null (p = 0.32) |
| `full_gloss_ft_ex` | fine-tune, definition + examples | 24.0 | 20.2 | 48.1 | 0.283 | 15.5% | −1.4 | no difference |
| `full_gloss_l12` | `all-MiniLM-L12-v2` (384d, 12L) | 23.0 | 18.5 | 44.9 | 0.265 | 15.4% | −2.4 | no difference |
| `full_gloss_gte` | `gte-small` (384d) | 22.6 | 17.4 | 44.9 | 0.254 | 16.5% | −2.8 | no difference |
| `full_gloss_mqa6` | `multi-qa-MiniLM-L6-cos-v1` (384d, **215M QA pairs**) | 18.5 | 14.3 | 39.0 | 0.219 | 16.4% | **−7.0** | **significant regression** (p = 0.007) |

> **The `R@10` column above was corrected on 2026-08-28 (RD-17).** It had been transcribed as *lenient* R@10 while every other table on this page — including the production table below — reports **strict** R@10 under the same heading, which is what the harness prints. Recomputed from the same committed runs, no re-scoring: `54.0 → 51.6`, `54.7 → 53.0`, `49.8 → 48.1`, `46.7 → 44.9`, `46.3 → 44.9`, `41.1 → 39.0`. **No verdict changes** — every delta the sweep resolves on is lenient R@1, which is untouched. Recorded rather than silently fixed, because two conventions under one column name is the kind of thing that gets compared across tables later.

- **The control cross-validates against `prod_gloss_p100` to the digit** — lenient 25.4% vs 25.4%, strict 21.6% vs 21.6%. Two independently built indexes, one in Postgres and one a local file, agreeing is what licenses reading the other five cells. Run that check first if these cells are ever rebuilt.
- **Nothing shipped**, and the ship gate failed on all three of its conditions independently: the best delta is below §9a's bar, the model is 768-dim, and its artifact exceeds RD-11's bundle budget.
- Cells are **not** committed (~1.3GB) and runs are not either, same posture as RD-12's. Rebuild with `scripts/build-encoder-cell.ts`; set `EVAL_CELL_DIR` somewhere outside the repo — the darwin default is under `os.tmpdir()` and gets reaped.

## Backlog (`backlog/`)

Tickets are static HTML, not an issue tracker: `backlog/index.html` lists them (with a size-vs-impact quadrant plot), `backlog/NN-slug.html` is each ticket's body, `backlog/style.css` is shared. IDs are sequential `RD-NN`, the same IDs referenced in commit messages (e.g. `c7eec8f RD-06/RD-07: …`).

- **Whenever a change has a big enough impact, turn it into a ticket** — add an `RD-NN` row to `index.html` and a `backlog/NN-slug.html` body following the existing structure (title/badges, meta-row, task/prerequisite-knowledge sections, learnings, acceptance criteria). If the change is already finished by the time you'd file it, file it as done rather than skipping it: `badge-done`, a completion date, and a one-line result summary in both the index row and the ticket body.
- Use judgement on "big enough" — a typo or a one-line config tweak doesn't need a ticket; a data migration, a removed/added subsystem, anything that changes retrieval behavior, or anything future work would need context on, does.
- Follow the existing badge (`badge-p0`…`badge-p3`, `badge-done`) and tag (`size:`, `impact:`) vocabulary already used in `index.html` — don't invent a new taxonomy per ticket.
- **`backlog/glossary.html` is the vocabulary reference for the whole backlog**, and `index.html`'s "Start here" section is its entry point. Every ticket opens with an *In plain terms* callout above its `.meta-row` and links terms into the glossary rather than redefining them inline — follow both conventions in new tickets, and add an entry to the glossary rather than explaining a recurring term in a ticket body.
- **Open tickets worth knowing about before proposing retrieval work:** RD-10 (real-phrasing eval set) is the only one with a live case. **RD-17 is done and POSITIVE** — the vocabulary expansion shipped; read METHODS §15 before touching the candidate set again, particularly the finding that added senses are not purely distractors. **RD-19 and RD-20 were filed out of RD-17 and are open:** RD-19 (P1) is that `GlossEmbedding.gloss` holds a human-written definition for all 519,793 answerable words while 332 of the 477 `Word` rows render empty — the app fetches the text, ranks on it, and discards it before display. RD-20 (P2) is that the eval harness's `dbMs` cannot see cold-cache latency by construction: it warms the database and runs 405 queries in sequence, so its p95 *improved* when the index grew 5.9×, while a server-side `EXPLAIN ANALYZE` measured the same scan at **61ms warm and 2,678ms cold**. **RD-09/RD-14/RD-15 are HELD, not open** — RD-16 measured their premises on 2026-08-28: RD-14's register gap is closed (+1.8pp), RD-09's corpus bet lost 7.0 points when run by proxy, and RD-15 depends on RD-14. Read METHODS §14 before proposing retraining again. **RD-12 is done and NEGATIVE** — off-the-shelf cross-encoder reranking was measured and rejected, so RD-13 (its serving path) stays blocked by its own gate; read METHODS §13 before proposing reranking again, because the 53pp ceiling it names is real and the tool that was supposed to reach it is not. "Build an eval harness" is already done — see "Evaluation" above; the open gap is RD-10's register coverage, not the harness itself.

## Commands

```bash
npm run dev            # local dev
npm run build          # prod build
npm run lint
npx tsc --noEmit       # type-check (run before committing)
npm run fetch-model    # download the ONNX model into models/ (idempotent; build runs it too)

npm run build-viz      # rebuild /explain's two static assets (PCA snapshot + WordPiece vocab)
npm run verify-viz     # RD-18's honesty gate — see below; run it after touching retrieval

npm run eval:prod      # offline eval of the PRODUCTION path (gloss index, probes=40)
npm run eval           # same set against the lemma index — now the rollback path
npm run eval:exact     # nearest-neighbour ceiling (sequential scan)
npm run eval:filtered  # with junk-vocabulary filter
npm run eval:rerank    # RD-12: cross-encoder rerank stage (measured, NOT shipped)
npm run eval:report    # regenerate eval/REPORT.md from eval/runs/*.json

# the fusion control, from a persisted shortlist — no model, no database
npx tsx scripts/probe-rerank-fusion.ts eval/runs/<tag>.shortlist.jsonl

# RD-16: has the register gap survived the cutover? (reads committed runs only)
npx tsx scripts/probe-register-gap.ts

# RD-16: a full-scale synset cell for any mean-pooled encoder (no DB, no pool manifest)
export EVAL_CELL_DIR=~/rd_eval_cells      # the darwin default is under os.tmpdir() and gets reaped
npx tsx scripts/build-encoder-cell.ts --model Xenova/gte-small --out full_gloss_gte
npx tsx scripts/verify-encoder-cell.ts    # 59-60/60 by SYNSET, and identifies the text variant by hash
npx tsx scripts/eval.ts --set eval/sets/v1.jsonl --index-file full_gloss_gte --tag full_gloss_gte

# a Phase E cell (local file-backed index; encoder follows the cell's model)
npx tsx scripts/eval.ts --set eval/sets/v1.jsonl --tag cell_gloss_ft --index-file eval_gloss_ft --per-sense

# RD-17: the vocabulary expansion, in the order it has to run
npm run probe:oewn           # Open English WordNet delta — measured, NOT adopted
npm run probe:reachability   # do the frozen set's `reachable` flags still hold? (read-only)
npm run supplement:fetch     # 3.2GB Kaikki extraction + OEWN into RD_SOURCE_DIR (~/rd_sources)
npm run supplement:build     # apply the committed filter, both arms, write the manifest
npm run supplement:cell      # embed the superset ONCE, compose both cells onto full_gloss_ft
npm run supplement:verify    # input hash, byte-identical prefix, self-retrieval in BOTH halves
npm run eval:control         # rd17_control — must reproduce RD-16's full_gloss_ft to the digit
npx tsx scripts/eval.ts --set eval/sets/v1.jsonl --index-file full_gloss_wikt_new --tag rd17_wikt_new
npx tsx scripts/eval.ts --compare eval/runs/rd17_control.json eval/runs/rd17_wikt_new.json
npm run supplement:index -- --cell full_gloss_wikt_new --dry-run   # PAST THE GATE ONLY
```

## Repo hygiene

- Platform: Windows / PowerShell. `_model_tmp/`, `reverse_dict_model.zip` and `models/` are gitignored (large model/seed artifacts). `models/` is regenerated by `npm run fetch-model`, which `npm run build` runs automatically — a failed fetch **fails the build** by design, since `lib/embedder.ts` loads with remote fetching disabled.
- **File tracing pulls in `onnxruntime-node` binaries for every platform.** The `/api/lookup` bundle traced at 195.3MB until `outputFileTracingExcludes` dropped the darwin/win32 copies (43.7MB a linux function can never run), bringing it to 151.6MB. Re-check this if the model or the ONNX runtime is ever upsized — the legacy function limit is 250MB.
- **Deploy by pushing to `main`** — the Git integration clones the repo, so `.gitignore` applies and the build is correct. `vercel deploy --prod` **fails**: the CLI uploads the working directory instead, sweeping in `reverse_dict_model.zip` and `_model_tmp/` (~1.5GB) and blowing the 100MB per-file cap. `.gitignore` does not apply to CLI deploys — only `.vercelignore` does, and there isn't one.
- The repo lives under OneDrive. Its placeholder files make Next's startup cleanup of `.next` fail with `EINVAL: readlink …`, and `next dev` then **exits 0 without serving**. If dev dies instantly, `rm -rf .next` and restart.
- ESLint config is `.eslintrc.json` (`next/core-web-vitals`). Without it `npm run lint` drops into an interactive setup wizard and hangs non-interactive shells.
- **Committed `/explain` artifacts:** `public/viz/pipeline-snapshot.json` (~800 KB, 280 KB gzipped) and `public/viz/wordpiece.json` (293 KB). Both are committed rather than built in CI: the page cannot render without them, and the snapshot needs a database the build does not have. Regenerate with `npm run build-viz` — the PCA fit is deterministic, so a rebuild against the same data is byte-identical. `public/` did not exist before RD-18.
- **`npm run verify-viz` is the gate on `/explain` telling the truth**, and it is cheap. It asserts: the serving `SELECT` is byte-identical to a frozen copy with both debug options off; the debug branch returns the same words as the serving branch; the browser tokenizer matches `AutoTokenizer`; the pooled vector is the mean of the real token vectors; and retrieved synsets project onto their snapshot coordinates. Run it after touching `lib/glossSearch.ts`, `lib/embedder.ts`, or `lib/viz/*`.
- **RD-17's committed artifact is `eval/data/supplement-manifest.json`** — the filter's recorded output: per-arm row counts, per-rule kill counts, the source sha256 and the CC BY-SA licence string. The 3.2 GB Kaikki extraction (`RD_SOURCE_DIR`, default `~/rd_sources`), the filtered JSONL and the composed cells (`EVAL_CELL_DIR`) are **not** committed — all three regenerate from that manifest's URL plus `scripts/lib/wiktionary.ts`. Committing a cache is not the same as committing a record.
- **Committed eval artifacts:** `eval/data/zipf-en.tsv` (1.7 MB), `eval/sets/*.tsv|jsonl`, and the reference runs `eval/runs/baseline.json` / `exact.json` / `filtered.json` / **`prod_gloss_shipped.json`**. **Rerank runs are not committed** — they carry a persisted shortlist and run ~5.8 MB, they describe a rejected experiment rather than a production path, and CLAUDE.md already cites uncommitted runs (`prod_gloss`, `prod_gloss_p100`) in its own tables. Regenerate with `npm run eval:rerank`; the `*.shortlist.jsonl` sidecars are gitignored. **`eval/runs/prod_wikt_shipped.json` is the current production path** and is what `npm run eval:prod` writes; `prod_gloss_shipped` is now the **pre-expansion** reference (RD-17 deliberately changed the `eval:prod` tag rather than let the script overwrite it), and `baseline`/`exact`/`filtered` describe the pre-cutover lemma index, which is the *rollback* path. Compare new runs against `prod_wikt_shipped` unless you specifically mean "versus what we replaced". Ignored: the rest of `eval/runs/`, `eval/audit/`, `eval/data/pool-manifest.json`. Vector cells (~230 MB) live outside the repo entirely — see `EVAL_CELL_DIR`.
- **Don't pipe a loop's command through `tail`/`head` when you care whether it worked.** The pipeline reports the exit status of the *last* stage, so six consecutive failures reported success and wasted a 37-minute run. Check status per iteration, or use `PIPESTATUS`.
- Other docs: `README.md` (overview, local setup, API reference), `ARCHITECTURE.md` (system design), `DEPLOYMENT.md` (deploying to Vercel). Consolidated from five docs to three on 2026-08-26 — `SETUP.md` and `GETTING_STARTED.md` were near-duplicates of README's own setup section and were folded into it rather than kept as separate files.
