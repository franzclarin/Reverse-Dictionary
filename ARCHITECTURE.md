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
│     (SET LOCAL ivfflat.probes = 40, inside a transaction)    │
│  3. expandSynsets(): synsets → member lemmas, deduped        │
│  4. return { results: [{ word, similarity }], timingMs }     │
└────────────────────│─────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│            Neon Postgres — "GlossEmbedding"                  │
│  693,325 rows, one per sense, halfvec(384), IVFFlat           │
│  (halfvec_cosine_ops) — 117,791 WordNet 3.0 synsets           │
│  ("<pos>:<offset>") + 575,534 Wiktionary senses               │
│  ("wikt:<word>:<pos>:<n>"), added by RD-17                    │
│                                                               │
│  "VocabEmbedding" (141,854 bare lemmas, vector(384),          │
│  lists = 150) stays populated and indexed as the rollback     │
│  path, and still backs word pages' related-words lookup.      │
└─────────────────────────────────────────────────────────────┘
```

Word pages (`/word/[word]`) follow a separate, cheaper path: `getRelatedWords()` reads the word's **already-stored** vector via a subquery and finds nearest neighbours — it never re-runs the ONNX model. `getWordData()` returns an existing `Word` row if one was profiled before the Claude removal, or creates a minimal row with empty text fields otherwise; there is no generative fallback that could fill those fields in.

**Which table decides what (RD-17).** Existence comes from `GlossEmbedding` — whatever search can return must render — while neighbours still come from `VocabEmbedding`, which is what a nearest-neighbour-of-a-word query is actually good at. These were both the lemma table until RD-17, and the mismatch meant **8,005 words search could return had a page that 404'd** — a figure the same ticket's expansion took to **379,633**, which is why it had to be fixed in the same change. Words with no lemma vector fall back to a *sense* neighbourhood over `GlossEmbedding`; words with no vector in either table get no neighbour list rather than a meaningless one.

## Data Flow

1. **User input** — a query typed on the landing page (`app/page.tsx`) routes to `/search?q=...`, which owns the actual `/api/lookup` call so every entry point (landing page, results page's own search bar) goes through one code path.
2. **Frontend → `/api/lookup`** — `POST { query: string, k?: number }`.
3. **Embed** — `embed(query)` produces a 384-dim, L2-normalized vector (mean pooling over token embeddings, then normalize).
4. **pgvector search** — cosine distance (`<=>`) against `GlossEmbedding`'s 693,325 sense rows via an approximate IVFFlat index, with `probes` set per-query. `probes` is **not the lemma index's 10**: the same setting that costs ~0.3pp on `VocabEmbedding` cost 5.5 points of lenient Recall@1 here, because gloss vectors cluster far less cleanly than bare lemmas. `lists` and `probes` were both re-tuned when RD-17 grew the table nearly six-fold — see `GLOSS_PROBES` and `GLOSS_LISTS` in `lib/glossSearch.ts` for the measured sweeps.
5. **Sense expansion** — rows come back as senses, not words. A Wiktionary row carries exactly one lemma, so expansion is a no-op for it; only WordNet synsets have mates. `expandSynsets()` (`lib/glossSearch.ts`) unpacks each into its member lemmas in WordNet's own within-synset order, dedupes by word across synsets, and truncates to `k`; each word inherits its synset's similarity. Synset mates carry bit-identical vectors, so their relative order is a deliberate *policy* (sense familiarity), not a retrieval result — and the array must never be sorted.
6. **Response** — `{ results: [{ word, similarity }], timingMs }`; `similarity = 1 - cosine_distance`. Unchanged by the cutover, which is why the frontend needed no modification.
7. **Frontend display** — the results page renders the ranked list; clicking a word navigates to its page, which runs the separate `getRelatedWords()`/`getWordData()` path described above.

There is no system prompt, no JSON-contract parsing, and no retry-on-malformed-response logic anywhere in this flow — retrieval is a single vector comparison, not a model "answering" a question.

## Known Limitations (measured, not hypothetical)

- **Retrieval is still the weak part of this app.** Lenient Recall@1 is **24.0%** on the frozen 287-query set (strict 20.6%, R@10 49.8%). Roughly one query in four puts the intended word first, and about half put it somewhere in the top ten. That is a large improvement on what came before, not a solved problem.
- **Lexical echo is largely fixed, and this is what fixed it.** When search ran over bare lemmas in `VocabEmbedding`, ~41% of top-10 results shared a word stem with the query (`rain` → `raininess`, `rainstorm`, `raindrop`) and outscored the intended answer. Indexing gloss text per synset cut that to **14.5%** and roughly doubled R@10 — recall and echo moved together, which is what a genuine representation fix looks like. Cut over 2026-08-27; see CLAUDE.md's "Headline results" for the paired test (55 wins / 15 regressions, p < 0.00001).
- **The fine-tune's contribution is small**: swapping in the untouched base model only costs ~4.5 points of lenient Recall@1 — a measured null result against the pre-committed bar. Changing *what is indexed* beat retraining the model by roughly threefold.
- **The eval set is single-register.** All 287 authored queries were written blind by one person in one session. It is not a sample of real user queries, so these numbers describe one writer's phrasing, not the general case. Tracked as RD-10 in `backlog/`. No query text was logged until 2026-08-31, when RD-24 added `QueryLog`; those rows are unlabelled — they carry no correct answer, so they can characterise phrasing but can never score retrieval — and there is not yet enough traffic to build a set from either way.
- **~5% of the vocabulary is unreachable**: `VocabEmbedding` covers ~95% of WordNet 3.0, and the missing rows are mostly Latin taxonomy plus ~258 orphaned verbs. A diffuse coverage tax, not a structural hole.

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

1. **Cold start**: the embedding model **ships inside the function bundle** and is read from local disk — it is never downloaded at request time (RD-11). It is loaded on-demand and cached per warm instance (`globalThis._embedderPromise`), which now costs ~64ms rather than the ~39s the HF CDN download used to take (that wait was 99.8% network, 0.2% ONNX init). `maxDuration = 60` on `/api/lookup` is retained as a safety ceiling, not because loading is slow. The promise is deliberately cleared on rejection so one bad load doesn't wedge every subsequent request on that instance.
2. **Approximate index**: IVFFlat trades a small amount of recall for large speed gains over an exact scan — see CLAUDE.md for the measured cost.
3. **`React cache()`** on `getWordData`/`getRelatedWords` means the word page and its `generateMetadata` share one query per request instead of duplicating it.

Deployment steps, checklist, and production troubleshooting live in **[DEPLOYMENT.md](DEPLOYMENT.md)** — not duplicated here.

## Open / Staged Work

The synset-keyed gloss index (`GlossEmbedding`, `halfvec(384)`) **shipped on 2026-08-27** and is what `/api/lookup` searches — see the diagram and data flow above. `VocabEmbedding` stays populated and indexed as the rollback path; reverting the single `searchGloss()` call in `app/api/lookup/route.ts` is the entire rollback, with no data migration involved.

**Reranking was measured and rejected (RD-12, 2026-08-28).** A cross-encoder rerank stage exists in the offline harness only; `/api/lookup` was never touched and users saw no change, so the recall figures above still describe what is served. The opportunity is real — the intended word is inside the top 100 for **77.0%** of queries against 24.0% at rank 1 — but three arms of off-the-shelf `ms-marco-MiniLM` cross-encoders all scored *below* plain retrieval (−3.8 / −2.4 / −2.1 points of lenient Recall@1), because MS MARCO trains web-passage relevance and these models rank glosses by term overlap with the query. That is lexical echo relocated from the index into the reranker. `backlog/13-rerank-serving-path.html` — the serving half — stays blocked by its own gate, which is what the build-then-cut-over split was for. See `eval/METHODS.md` §13.

**The vocabulary was expanded, and the cautious arm was the one that failed (RD-17, 2026-08-28).** `GlossEmbedding` grew from 117,791 WordNet senses to **693,325** by adding a filtered slice of English Wiktionary — 575,534 senses over 443,645 words, chosen by a filter committed as code (`scripts/lib/wiktionary.ts`) rather than described in prose. Two arms were built as full-scale local cells and scored before any write. Indexing only words WordNet *lacks* lost **8.4 points** of lenient Recall@1 with **24 regressions and zero wins**: on the questions the benchmark scores, those rows can only be distractors. Indexing **every** surviving sense — including new senses of words already covered — came out **flat** (−0.3pp, 23/22, p = 1.00) while lifting Recall@10 from 54.0% to 59.9% and the coverage slice from **0.0% to 32.0%**. The extra senses are second surfaces for correct answers, and they pay for the distractors they arrive with. Echo rose 14.6% → 17.3%, explained and bounded (added words echo at 21.0% against WordNet's 15.0%; only 7 of 23 lost rank-1s were displaced by one). Rollback is `DELETE FROM "GlossEmbedding" WHERE "synsetKey" LIKE 'wikt:%'` — the WordNet rows were never touched. Wiktionary text is **CC BY-SA**, so attribution and share-alike travel with this index. See `eval/METHODS.md` §15.

**Retraining was evaluated and held (RD-16, 2026-08-28).** The three retraining tickets that RD-12's result unblocked were checked before being funded, and both of their load-bearing premises failed. The *register gap* — dictionary-phrased queries outscoring hand-written ones, which is the entire case for synthesising query-style training data — was **+26.1 points on the old lemma index and is +1.8 on this one**: the cutover closed it, with no training at all. And across six full-scale cells over all 117,791 synsets, **no off-the-shelf encoder beat the current fine-tune**; `multi-qa-MiniLM-L6-cos-v1` — same architecture and width, pretrained on 215M question–answer pairs instead of 181k WordNet triplets — scored **7.0 points below** it (p = 0.007). The one arm above the control, `all-mpnet-base-v2`, is +2.8 points (a null result), 768-dimensional so it does not fit a `halfvec(384)` column under Neon's ceiling, and too large for the in-bundle model budget. Nothing was served and no data was migrated. `backlog/09`, `backlog/14` and `backlog/15` are held rather than cancelled — the never-retrieved 23% is still only reachable by a better representation, but the prior on obtaining one by retraining is now measured and negative. See `eval/METHODS.md` §14.

**Every search is now recorded (RD-24, 2026-08-31).** `/api/lookup` writes one `QueryLog` row per non-debug **search**: the description as typed, the requested `k`, and the exact `[{word, similarity}, …]` array it returned, as `jsonb` in rank order. *Per search, not per request* — that distinction is RD-25 and it was not free: RD-24 shipped keyed on the request, and React StrictMode's deliberate double-invocation of an effect with no cleanup meant the UI sent every search twice, so every query wrote two rows. The client now aborts on cleanup and sends one `searchId` per search, and a `@unique` index on it makes a duplicate arrival conflict and be skipped rather than become a second row. The write is **awaited** — a fire-and-forget insert would be truncated when the function is frozen after the response, and Next 14.2 has no `after()`/`waitUntil` — but wrapped, so a log failure logs `[lookup] query log failed (non-fatal)` and the search still returns 200. `/explain`'s `debug: true` requests are excluded, the same way the shadow log excludes them; "Load more" re-runs the query with a larger `k`, so repeated rows with the same text are expected and `k` is stored to explain them.

This **retires the "no query text has ever been logged" property** that `ShadowLookup` was built to preserve, and that is a change of posture rather than a new table — it is why RD-24 also amended CLAUDE.md, README.md and this file rather than quietly falsifying them. What the rows license is narrow: they are **unlabelled**, carrying no correct answer, so they characterise phrasing, length and which words get returned, and can never score retrieval. That is `lib/shadowLookup.ts`'s "agreement is not accuracy" argument applied to a richer log. RD-10's labelled Stack Exchange harvest remains the measurement, not something this replaces.

`ShadowLookup` still logs, with its roles inverted: the gloss index is now primary, so the sampled shadow query runs against the old lemma index. Its columns keep their original meaning (`old*` = lemma, `new*` = gloss) so pre- and post-cutover rows stay comparable. It was **never used to gate the cutover** — that gate assumed live traffic this app does not have, and was retired at n≈2 rather than satisfied. The decision was made on the offline eval set instead. See `backlog/02-embedding-cutover.html` for the decision record and `backlog/10-real-phrasing-eval-set.html` for the measurement that replaces it.
