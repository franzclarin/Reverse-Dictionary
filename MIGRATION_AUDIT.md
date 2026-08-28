# Migration Audit Log

Running log for the machine-migration audit of the Reverse Dictionary repo, per the session
instructions dated 2026-08-22. Append-only — each phase's findings are logged before moving to
the next phase. If this session is interrupted, a fresh session should read this file in full
before redoing any work.

---

## Phase 0 — Orient before touching anything

**Status: BLOCKED partway through — see "Critical blocker" below. Report is otherwise complete.**

### Docs read

Read `CLAUDE.md`, `ARCHITECTURE.md`, `DEPLOYMENT.md`, `GETTING_STARTED.md`, `SETUP.md`, `README.md`
in full.

**Major finding: everything except `CLAUDE.md` is stale by roughly a dozen commits and describes
a different application.** `ARCHITECTURE.md`, `DEPLOYMENT.md`, `GETTING_STARTED.md`, `SETUP.md`,
and `README.md` all still describe the *original* Claude-powered app:

- `ANTHROPIC_API_KEY` as a required env var (all five files)
- Claude Sonnet 4 (`claude-sonnet-4-20250514`) as the search engine, with a JSON system-prompt
  contract (`ARCHITECTURE.md`)
- `/api/reverse-dictionary` as the search endpoint (all five files) — the actual route is
  `/api/lookup` (`app/api/lookup/route.ts`, confirmed by reading `CLAUDE.md`'s own account of the
  flow and by grepping `app/api/`)
- `lib/claude.ts`, `app/api/reverse-dictionary/route.ts` as files that no longer exist
- `GETTING_STARTED.md` literally has a "✅ Complete and Ready for Production" checklist for the
  Claude-based build
- None of the five mention pgvector, `VocabEmbedding`, Transformers.js, the fine-tuned
  `franzclarin/ReverseDictionary` model, or the eval harness at all

Per `CLAUDE.md`, Claude was removed entirely on 2026-08-18 (commit `666f59e` "Build word pages
from the embedding model, drop the Claude dependency" and `85f96fe`/`dd278e6`/`4740a25` in the log
below). These five docs were never updated to match. **This is real, pre-existing documentation
drift — not something the machine move caused** — but it means a fresh reader following
`SETUP.md`/`GETTING_STARTED.md`/`README.md` today would configure the wrong env var
(`ANTHROPIC_API_KEY`, which the app no longer reads at all — `CLAUDE.md` confirms
`there is no @anthropic-ai/sdk and no ANTHROPIC_API_KEY`) and hit the wrong endpoint.
`CLAUDE.md` itself is internally consistent and appears to be the only trustworthy doc in the
repo; the other five need a rewrite pass but that is out of scope for this migration audit unless
directed otherwise.

### Git state

```
On branch main
Your branch is up to date with 'origin/main'.
Changes not staged for commit:
  modified:   .claude/settings.local.json
```

- Local HEAD and `origin/main` are both `3976e9631602c485efe130ac5981f12b331206da` — **identical**,
  confirmed via `git fetch origin` + `git rev-parse HEAD` / `git rev-parse origin/main`. No drift,
  nothing to push or pull.
- The only working-tree change is `.claude/settings.local.json`, and the diff is purely permission
  allowlist entries this session added while running discovery commands (`git fetch *`,
  `command -v nvm`, `command -v brew`, etc.) — harness-managed noise, not user work in progress.
  Not something this audit should touch or worry about.
- Last 20 commits (`git log --oneline -20`) confirm the Claude-removal history CLAUDE.md
  describes: `666f59e` (word pages off Claude), `4740a25`/`1cd6f7f` (embedding-only search,
  Transformers.js in-function), `591ca41`/`30f0b25` (Redis `KV_*` + fail-open), up through
  `3976e96` (offline eval harness, the current HEAD).

### What did NOT survive the machine move

- **`reverse_dict_model.zip`** — absent at repo root, as expected (gitignored, large binary, never
  meant to transfer via git). Its presence isn't actually load-bearing for anything in the
  documented "Next steps" (Phase E gloss-index build) — `CLAUDE.md` only cites it as containing
  the original sentence-transformers artifacts, not something the eval harness or production
  reads at runtime.
- **Eval cell directory (`EVAL_CELL_DIR`)** — unset, and the default path doesn't exist. Note the
  default is *platform-conditional* in `scripts/lib/localIndex.ts`: `C:/Temp/rd_eval_cells` on
  Windows, `os.tmpdir()/rd_eval_cells` elsewhere. **This machine is macOS** (Darwin), not Windows —
  see platform-mismatch note below — so the relevant default is
  `$TMPDIR/rd_eval_cells`, which also does not exist. The six Phase E cells (`cell_lemma_ft`,
  `cell_gloss_ft`, etc., ~230 MB total per `CLAUDE.md`) did not transfer and would need a full
  rebuild (`build-eval-pool.ts` → `embed-eval-pool.ts --cell <name>` × 6, ~35 min per `CLAUDE.md`)
  if Phase E work resumes. Not required for the "Next steps" item (production synset-keyed gloss
  index), which is a Postgres build, not a local-cell rebuild.
- **`.env.local`** — **absent**. Confirmed via direct `ls`. No `DATABASE_URL`, no Clerk keys, no
  `KV_REST_API_URL`/`KV_REST_API_TOKEN`. This blocks the dev server, `npm run eval` (needs
  `DATABASE_URL` for the pgvector roundtrip), and any DB-touching script. Gitignored by design
  (`.gitignore` line `.env*.local`), so its absence is expected after a machine move, not a repo
  problem — but it is a real credential-provisioning task before Phase 3 can run anything against
  the database. No `.env.example` exists in the repo to copy from (checked — also absent), despite
  `SETUP.md`/`GETTING_STARTED.md` instructing `cp .env.example .env.local`. The variable *names*
  needed are documented in `CLAUDE.md`'s "Env" section and (partially, and with the wrong var list)
  in `README.md`'s env table.

### Critical blocker — Node.js toolchain is not installed on this machine

This was supposed to be a verification step ("does `npm install` complete clean, does
`npx tsc --noEmit` pass") and instead surfaced a bigger problem:

```
$ which node; which npm
node not found
npm not found
$ command -v brew
(not found)
$ ls ~/.nvm
No such file or directory
```

- **No `node`, no `npm`, anywhere on `$PATH`.** `$PATH` is
  `/Users/franzclarin/.local/bin:/usr/local/bin:/System/Cryptexes/App/usr/bin:/usr/bin:/bin:/usr/sbin:/sbin:...`
  — checked `/usr/local/bin/node` and `/opt/homebrew/bin/node` directly, neither exists.
- **No Homebrew** (`brew` not found, no `/opt/homebrew`).
- **No nvm** (`~/.nvm` doesn't exist, `command -v nvm` empty).
- Xcode Command Line Tools *are* installed (`xcode-select -p` →
  `/Library/Developer/CommandLineTools`), so this isn't a completely bare machine, but the entire
  JS toolchain is missing.
- **This confirms the platform mismatch CLAUDE.md's "Repo hygiene" section doesn't yet account
  for**: CLAUDE.md states "Platform: Windows / PowerShell" and documents a OneDrive-specific
  `EINVAL: readlink` dev-server bug. This session's environment is **Darwin (macOS)**, working
  directory `/Users/franzclarin/Desktop/Reverse-Dictionary` — not under OneDrive. So this isn't
  just a machine move, it's a **Windows → macOS platform move**. The OneDrive gotcha likely no
  longer applies (no OneDrive in the path), but that should be confirmed rather than assumed once
  `next dev` can actually run. `EVAL_CELL_DIR`'s Windows-specific default (noted above) is a second
  instance of the same platform assumption baked into the repo.
- Disk space is not the constraint: 867 GiB free on `/System/Volumes/Data`. Plenty of room for
  `node_modules`, Homebrew, and eval cells.

**None of Phase 0's remaining verification steps (`npm install`, `npx tsc --noEmit`, running
anything under `npm run eval`) can execute until a Node.js toolchain exists on this machine.**
This blocks not just the rest of Phase 0 but all of Phase 3 (build/validate), since every
validation step specified in the session instructions is an `npm`/`npx` command.

Installing a JS toolchain (Homebrew + Node, or nvm + Node) is not one of the three explicit
hard-stop actions named in the session instructions (frozen eval set, `VocabEmbedding` writes,
model retraining) — but it also isn't something those instructions anticipated needing, it's a
machine-wide environment change (not scoped to this repo), and an unattended Homebrew install
in particular runs a remote install script and can prompt for `sudo`, which would hang
non-interactively in this tool environment. Rather than guess at how the user wants their new Mac
provisioned, this was surfaced to the user directly as a question (Homebrew+Node vs. nvm+Node vs.
user installs manually) before proceeding further.

**Resolution:** user chose Homebrew + Node. Attempted a non-interactive install
(`NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL .../install.sh)"`); it stopped immediately with
`Need sudo access on macOS (e.g. the user franzclarin needs to be an Administrator)!` — this
sandboxed shell has no way to supply a sudo password interactively. Asked the user a second time:
switch to nvm (no sudo needed) vs. run the Homebrew installer themselves in their own terminal.
**User chose to run Homebrew themselves.** Session is paused here waiting for confirmation that
Homebrew is installed, at which point this file resumes with `brew install node` and the rest of
Phase 0's verification steps (`npm install`, `npx tsc --noEmit`).

### Status report — shipped vs. open, per CLAUDE.md's own account

**Shipped and in production today** (per CLAUDE.md, cross-checked against the commit log above —
consistent, no contradiction found):
- Search: `embed(query)` via `franzclarin/ReverseDictionary` (Transformers.js, in-function ONNX) →
  pgvector `<=>` search over `VocabEmbedding` (141,854 rows, IVFFlat `lists=150`) → top-k with
  similarity, no Claude fallback anywhere.
- Word pages (`/word/[word]`) powered entirely by `getRelatedWords()` (nearest-neighbour over
  stored vectors) and whatever `Word` row already exists; new rows get empty text fields, not a
  generated definition.
- Auth (Clerk), rate limiting (Upstash `KV_*` via `getRatelimiters()`, fail-open), credits/games/
  leaderboard — all listed as running, unaffected by the Claude removal.
- Offline eval harness (`scripts/`, `eval/`) — read-only, frozen set `eval/sets/v1.jsonl`
  (sha256 `cc03e1347ff696fb253c92dfb8b9e7455c64b2122f711ed5c288f33b06c0ccc8`), committed reference
  runs (`eval/runs/baseline.json`, `exact.json`, `filtered.json`).

**Open / unresolved per CLAUDE.md's "Next steps" section** (the only place CLAUDE.md itself calls
something unfinished):
1. Production build of a synset-keyed gloss index at `halfvec(384)` (~114,662 rows, ~88 MB),
   which requires dropping `VocabEmbedding`'s IVFFlat index to fit the 512 MB Neon ceiling — **not
   yet built**.
2. The cutover decision itself — gated on shadow-log agreement over real production traffic, not
   on the 287-query hand-authored set alone — **explicitly stated as not yet decided**.

Nothing else in CLAUDE.md is framed as unfinished; the rest of the document is "established facts"
and "known limitations," which are permanent characteristics of the current design, not TODOs.

**Drift found between CLAUDE.md's claims and the repo's actual state:**
- The five stale docs above (ARCHITECTURE/DEPLOYMENT/GETTING_STARTED/SETUP/README) contradict
  CLAUDE.md's "no Claude dependency" claim, though this is pre-existing drift, not something this
  migration caused.
- No other contradiction found: git log matches CLAUDE.md's narrative, `package.json` scripts
  match the documented eval commands (`eval`, `eval:exact`, `eval:filtered`, `eval:report`) exactly,
  `.gitignore` matches CLAUDE.md's "Committed eval artifacts" section exactly (zipf-en.tsv, sets,
  baseline.json committed; runs/audit/pool-manifest ignored).

**What's needed to reproduce the documented eval numbers on this machine, in order:**
1. A working Node.js/npm toolchain (**currently missing — the blocker above**).
2. `npm install` (clean run unverified — blocked).
3. `.env.local` with a working `DATABASE_URL` (Neon owner role) at minimum — `npm run eval` needs
   the real pgvector roundtrip against production `VocabEmbedding`. Read-only access is sufficient;
   the eval harness never writes.
4. `npx tsc --noEmit` passing (unverified — blocked).
5. `npm run eval` (baseline), `npm run eval:exact`, `npm run eval:filtered` — compare output against
   the committed reference runs (`eval/runs/baseline.json` etc.) and the headline table in
   CLAUDE.md's "Headline results" section.
6. Phase E cell reproduction is **not** required to reproduce the *headline* numbers above (those
   run against live `VocabEmbedding` via Postgres) — only needed if re-validating the local-file
   Phase E comparisons (`cell_gloss_ft` etc.), which would additionally require rebuilding the six
   eval cells from scratch (~35 min, `EVAL_CELL_DIR` didn't transfer, see above).

### Phase 0 — closed out

Toolchain blocker resolved: user installed Homebrew themselves (this sandboxed shell can't supply
a sudo password), then `brew install node` ran cleanly from here — **Node v26.7.0, npm 11.19.0**
now on this machine at `/opt/homebrew`. Gotcha for future sessions/commands on this machine: a
fresh non-interactive shell does **not** source `~/.zprofile`, so `node`/`npm`/`npx` resolve to
nothing until `/opt/homebrew/bin` is explicitly on `$PATH` — prefix commands with
`eval "$(/opt/homebrew/bin/brew shellenv)"` or `export PATH="/opt/homebrew/bin:$PATH"`.

- `npm install` completed clean: 500 packages added, `postinstall` (`prisma generate`) succeeded.
  Only noise: standard deprecation warnings (`rimraf@3`, `eslint@8`, `@clerk/clerk-react`, etc.),
  20 `npm audit` findings (17 high/3 critical — not investigated, out of scope for this migration
  audit; flagging for a future dependency-hygiene pass), and an `npm warn install-scripts` notice
  for 9 packages with install scripts not yet allow-listed under npm's newer install-scripts
  policy (`@prisma/client`, `sharp`, `esbuild`, etc. — these installed fine regardless; the warning
  is informational under this npm version, not a failure).
- `npx tsc --noEmit` — **passes cleanly, exit 0, no output.** Confirms the codebase itself
  transferred correctly and type-checks on Node 26 / this Mac despite CLAUDE.md's "Repo hygiene"
  section describing a Windows/PowerShell dev environment.
- **Platform-mismatch confirmation:** this is a genuine Windows → macOS move, not just a new
  machine. Working directory is `/Users/franzclarin/Desktop/Reverse-Dictionary`, not under
  OneDrive, so CLAUDE.md's documented `EINVAL: readlink` /`next dev` OneDrive bug should no longer
  apply — worth confirming once `next dev` is actually run, rather than assuming. `EVAL_CELL_DIR`'s
  Windows-specific default path in `scripts/lib/localIndex.ts` is the other place this assumption
  is baked into the repo; on this machine it now resolves to `$TMPDIR/rd_eval_cells` instead.

**Phase 0 is now fully closed out.** `npm install` clean, `tsc --noEmit` clean, git state clean and
in sync with `origin/main`, toolchain gap resolved. Remaining pre-Phase-3 blocker: no `.env.local`
yet (see Phase 3 below for how this was resolved).

### `.env.local` provisioning — resolved

Tried `npx vercel env pull` as the first option (Vercel CLI installed cleanly via `npx`, v59.5.0).
`npx vercel whoami` returned "Logged out" and no `.vercel/` link directory exists in the repo —
authenticating needs an interactive browser/email flow this sandboxed shell has no way to complete
(same category of blocker as the earlier Homebrew sudo prompt). Checked for a Vercel MCP/plugin
tool that might sidestep this (a CLI hint referenced a `vercel@claude-plugins-official` plugin) —
none is available in this session's tool list. Asked the user; **they ran `vercel login`
themselves.** Once logged in, `npx vercel link --yes` (this shell) succeeded non-interactively —
only one matching project (`franzclarin13-6614s-projects/reverse-dictionary`), so no ambiguous
prompt blocked it — followed by `npx vercel env pull .env.local`, which wrote real Development-
scope values: `DATABASE_URL`, `KV_REST_API_URL`/`KV_REST_API_TOKEN`/`KV_REST_API_READ_ONLY_TOKEN`,
`KV_URL`, `REDIS_URL`, `CLERK_SECRET_KEY`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `VERCEL_OIDC_TOKEN`.
Not present: `GAME_TOKEN_SECRET` (code falls back to an insecure dev default — fine for local eval/
dev, should be set before any real production use from this machine) and `NEXT_PUBLIC_SITE_URL`
(has a hardcoded fallback, non-blocking). `.env.local` is gitignored (`.env*` in `.gitignore`), so
none of this was ever at risk of being committed.

---

## Phase 1 — Scope the real open item

Per CLAUDE.md's own "Next steps" section, exactly two things are unfinished:

1. **Production build of a synset-keyed gloss index at `halfvec(384)`** (~114,662 rows, ~88MB),
   requiring `VocabEmbedding`'s IVFFlat index to be dropped to fit Neon's 512MB ceiling.
2. **The cutover decision itself** — explicitly gated on shadow-log agreement over real production
   traffic, not the 287-query hand-authored eval set alone.

**Neither item has a single line of implementing code anywhere in the repo.** Verified by grepping
the entire repository (not just `scripts/`) for `halfvec`, `shadow`, `ShadowLog`,
`answerable_vocab`, and `synset`:

- Every `halfvec`/`synset` hit is either prose in `CLAUDE.md`/`eval/METHODS.md`/`eval/REPORT.md`,
  or Phase E's **local file-backed** eval-cell tooling (`scripts/build-synset-cell.ts`,
  `scripts/quantize-cell.ts`, `scripts/lib/localIndex.ts`) — all of which write to
  `EVAL_CELL_DIR` on disk, never to Postgres. None of it creates, drops, or alters a live table
  or index.
- `shadow`/`ShadowLog` return **zero code hits** — only this audit file and CLAUDE.md's own prose
  describing the *unbuilt* gate, plus unrelated matches (the eval query word "shadow" itself, e.g.
  "rain shadow").
- `answerable_vocab` **does** exist as a real, committed database object, but it's unrelated to
  either open item: it's a Postgres **VIEW** (not a table, stores nothing) created by
  `scripts/audit-vocab.ts` for the already-settled junk-vocabulary experiment (`--filter-junk`).
  Noted for completeness, not a loose end.
- `prisma/schema.prisma`'s five models (`Word`, `SavedWord`, `User`, `Lookup`, `GameRound`,
  `VocabEmbedding`) confirm this directly: no gloss-index table, no shadow-log table. `Lookup` is
  `{id, userId, createdAt}` only — a rate-limit/credit counter, not a query log — which is exactly
  why CLAUDE.md states "No query text has ever been logged."

**Conclusion:** both open items require from-scratch design and implementation, not a small
finishing touch. This session designed both in full (via a dedicated Plan subagent grounded in
reading `app/api/lookup/route.ts`, `lib/embedder.ts`, `scripts/lib/wordnet.ts`,
`scripts/lib/metrics.ts`, `scripts/build-synset-cell.ts`, and the existing `VocabEmbedding`
migration SQL) and is writing the code for both — see "Phase 3" below for what was actually
written vs. deliberately left unapplied.

**No other loose end was found.** The five stale docs (`ARCHITECTURE.md`, `DEPLOYMENT.md`,
`GETTING_STARTED.md`, `SETUP.md`, `README.md`, logged under Phase 0) are pre-existing drift, not
something blocking either open item — they don't gate the gloss-index build or the cutover
decision, they just mislead a reader about the current architecture. Flagged, not treated as
in-scope "MVP" work per the user's explicit instruction not to invent unrelated scope.

## Phase 2 — Test design

Mapping each piece of the two open items to what the existing eval harness already covers, adding
new tooling only where a genuine gap exists:

| Work item | Validation | New tooling needed? |
|---|---|---|
| Reproducing CLAUDE.md's committed baseline/exact/filtered eval numbers on this machine | `npm run eval`, `npm run eval:exact`, `npm run eval:filtered`, then `npm run eval:report` to compute aggregates from the raw per-query JSON | No — exists, about to be run (Phase 3) |
| Reproducing the full 8-cell headline gloss-vs-lemma table | Phase E pipeline: `scripts/build-eval-pool.ts` → `scripts/embed-eval-pool.ts --cell <name>` (×6, ~35 min) → `scripts/eval.ts --index-file <cell> --per-sense` → `scripts/eval:report` | No — exists, but **user chose to skip this** for this session (time cost, not required to validate the migration itself) |
| Validating a *built* production `GlossEmbedding` table, if the migration is ever applied | `scripts/eval.ts --index GlossEmbedding` (Postgres-table mode, already supported by `eval.ts`'s `--index` flag) compared against local `cell_gloss_ft_synset` numbers already in CLAUDE.md | No — existing `--index` flag covers this once the table exists |
| Validating the gloss-index population script logic before touching production | `scripts/build-gloss-index.ts --dry-run` (new script, embeds + validates grouping without inserting) | **New script**, but its logic (WordNet read, synset grouping, embedding) directly reuses `scripts/lib/wordnet.ts` and `lib/embedder.ts` — not a new test methodology, just no existing script targets Postgres instead of a local cell |
| Validating shadow-log agreement between old and new indexes on real traffic | **New script** `scripts/shadow-compare.ts`, reusing `mcnemar()` from `scripts/lib/metrics.ts` where applicable | **Yes, genuine gap** — justified below |

**Why shadow-log validation is a genuine new-test gap, not something `eval.ts --compare` already
covers:** `eval.ts --compare` runs a paired McNemar test between two eval runs against a
**labelled** set (`eval/sets/v1.jsonl`, each row has a known-correct `target`). Production traffic
has no such label — CLAUDE.md is explicit that no query text has ever been logged, so there is no
ground truth to score shadow-logged queries against. A shadow log can only measure **agreement
rate** between the old and new systems' top-1 answers, not which one is *right*. This is a real
methodological gap the existing harness cannot fill, not a case of reinventing something that
already exists — flagged explicitly in the design below so "gated on shadow-log agreement" isn't
later mistaken for a full accuracy comparison.

**Hard-stop flags for Phase 2/3, called out before any implementation:**
- Dropping `VocabEmbedding`'s IVFFlat index — **named hard-stop #2.** Written into the new
  migration file as a commented-out, clearly labeled line; never executed this session.
- Running `scripts/build-gloss-index.ts`'s insert phase against the real production `DATABASE_URL`
  — same hard-stop boundary as above (writes to a table that only fits once the old index is
  dropped, per CLAUDE.md's measured `53100 project size limit exceeded` finding). Not run this
  session; `--dry-run` mode only.
- Applying the new `ShadowLookup` migration to production Neon, and pushing the `/api/lookup`
  route instrumentation to `main` — not one of the three literally-named hard-stops, but flagged
  in the same spirit (production schema change + change to the single most latency/reliability-
  sensitive route in the app) and the user explicitly chose "design and write code only" for this
  item this session.

---

## Phase 3 — Build and validate

### Gloss index — written, not applied

- `prisma/schema.prisma`: added `GlossEmbedding` model (`synsetKey` unique, `pos`, `gloss`,
  `lemmas String[]`, `embedding Unsupported("halfvec(384)")`), commented to explain it's staged,
  not yet populated, and not yet queried.
- `prisma/migrations/20260822000000_add_gloss_embeddings/migration.sql`: hand-authored SQL
  (following the existing `20260817000000_add_vocab_embeddings` pattern, since Prisma can't
  express `USING ivfflat`/`halfvec` DDL natively) — `CREATE TABLE "GlossEmbedding"`, unique index
  on `synsetKey`, `CREATE INDEX ... USING ivfflat ("embedding" halfvec_cosine_ops) WITH (lists =
  115)`. The `DROP INDEX "VocabEmbedding_embedding_ivfflat_idx"` line (needed to free ~230MB under
  Neon's 512MB ceiling) is present only as a **commented-out line with a "*** HARD STOP ***"
  banner** — not executed. **Not applied to any database this session.**
- `scripts/build-gloss-index.ts` (new): reads WordNet via `scripts/lib/wordnet.ts`'s
  `readSenses()`, groups by `pos:offset` synset key, embeds each synset's definition text with
  the production `embed()` from `lib/embedder.ts` (no reimplementation), and on a real run would
  batch-upsert into `GlossEmbedding` via `$executeRawUnsafe` with the same vector-literal pattern
  `app/api/lookup/route.ts`/`lib/wordData.ts` already use. Supports `--dry-run` (embed + validate,
  no DB write) and a real-run mode that refuses nothing but is clearly labeled as requiring the
  index-drop to have already happened deliberately. **Only `--dry-run` is safe to exercise without
  a live `DATABASE_URL`; not run this session at all since no `.env.local` exists yet (see
  above) — the script's logic was verified only via type-checking, not execution.**

### Shadow log — written, not applied, not deployed

- `prisma/schema.prisma`: added `ShadowLookup` model (`queryHash`, `oldTop1`/`oldSimilarity`,
  `newTop1`/`newSimilarity`, `agree Boolean`, `createdAt`, indexed on `createdAt`) — logs a query
  hash, never query text, preserving CLAUDE.md's existing "no query text logged" property; logs
  only top-1 per system, not full top-k or the embedding vector.
- `prisma/migrations/20260822000001_add_shadow_lookup/migration.sql`: new table, no vector
  column, low size risk on its own — but still a production schema change. **Not applied to any
  database this session.**
- `lib/shadowLookup.ts` (new): `runShadowLookup()` queries `GlossEmbedding` for the top-1 synset
  match (raw SQL, same reason `VocabEmbedding` needs it — the `halfvec`/`vector` column is
  `Unsupported` in Prisma), then `prisma.shadowLookup.create(...)` via the typed client (regular
  columns, no `Unsupported` type, so the typed client works here unlike for the vector tables).
- `app/api/lookup/route.ts`: added a **sampled, fire-and-forget** call to `runShadowLookup()`
  after the existing response's `rows` are computed, wrapped in `.catch()` so a failure (e.g.
  `GlossEmbedding` not existing yet) can never affect the user-facing response or its latency —
  and gated behind a hardcoded `SHADOW_LOOKUP_ENABLED = false` kill switch as a second safety
  layer beyond simply not deploying it, in case this file is ever run before being reviewed.
  **This diff is sitting uncommitted in the working tree — nothing has been committed or pushed.**
- `scripts/shadow-compare.ts` (new): reads `ShadowLookup` rows and reports **agreement rate**
  between old/new top-1 answers. Its header comment explicitly documents why `mcnemar()` (reused
  from `scripts/lib/metrics.ts` for its machinery, but not called with a meaningful `(b,c)` pair
  here) cannot be validly applied to shadow data — production traffic has no labelled target, so
  shadow logging can only measure disagreement rate, never accuracy. This is flagged so a future
  reader doesn't mistake "gated on shadow-log agreement" for a full accuracy re-test.

### Verification of the written code

- `npx tsc --noEmit` — **clean, exit 0** — after adding both new schema models, running
  `npx prisma generate` (codegen only, no DB connection — regenerates the local TypeScript client
  from `schema.prisma`; does not touch any database and is not one of the three hard-stops), and
  writing all four new/edited files (`scripts/build-gloss-index.ts`, `lib/shadowLookup.ts`,
  `app/api/lookup/route.ts`'s diff, `scripts/shadow-compare.ts`).
- `npm run lint` — **clean, "✔ No ESLint warnings or errors."**
- Neither migration has been applied to any database (local or production) this session.
  Neither `scripts/build-gloss-index.ts` nor `scripts/shadow-compare.ts` has been executed against
  a real database this session — both are blocked on `.env.local`, which is still pending (Vercel
  login/link, see above). Once `.env.local` exists, `scripts/build-gloss-index.ts --dry-run` is
  the safe next validation step (embeds and validates without writing).
- The `app/api/lookup/route.ts` diff has not been committed or pushed.

**Nothing above is marked "done" — everything is "written and type-checks," which is a distinct,
weaker claim than "validated against a real database," per the user's instruction not to claim
success without an attached result.**

### Eval validation — this machine reproduces the documented numbers

`.env.local` resolved (see above): `vercel login` (user), `vercel link --yes` (succeeded
non-interactively — only one matching project), `vercel env pull .env.local` — real `DATABASE_URL`
and Redis creds now present. Ran the three fast eval commands against the live production
`VocabEmbedding` table (read-only, per the harness's own design) and `eval:report`:

| run | lenient R@1 | strict R@1 | R@10 | MRR@10 | echo | CLAUDE.md match? |
|---|---|---|---|---|---|---|
| `npm run eval` (baseline, probes=10) | 10.1% | 5.6% | 26.1% | 0.109 | 40.7% | **exact match** to CLAUDE.md's `baseline` row |
| `npm run eval:exact` (sequential scan) | 10.5% | 5.9% | 30.0% | 0.119 | 44.3% | **exact match** to CLAUDE.md's `exact` row |
| `npm run eval:filtered` (junk predicate) | 10.1% | 5.6% | 26.8% | 0.110 | 40.6% | strict R@1/lenient R@1 unchanged vs baseline, R@10 +0.7pp — consistent with CLAUDE.md's "`--filter-junk` moved recall 0.0 points" finding |

`npm run eval:report` regenerated `eval/REPORT.md` cleanly (374 lines, 20.2 KB) from the three
fresh run files.

**This is the concrete answer to Phase 0's "does this machine reproduce the documented eval
numbers" question: yes, exactly, on the first attempt, with a real database round-trip (latency
`db p50` 552–869ms depending on run — consistent with CLAUDE.md's documented note that this is a
local-machine-to-Neon round trip, not production latency, since both sides are on this Mac now
instead of both being in Vercel's `iad1`).**

One side effect, corrected: `npm run eval`'s tag-based output naming means each run overwrites
`eval/runs/baseline.json` / `exact.json` / `filtered.json` — which are also the **committed
reference baselines** CLAUDE.md tracks in git. Diffing this run's output against the committed
version showed only 7th-decimal-place floating-point noise (ONNX execution-order nondeterminism,
not a real behavior change — the headline aggregates above are bit-for-bit what CLAUDE.md cites)
plus per-query `embedMs`/`dbMs` timing jitter and a fresh `ranAt` timestamp — no aggregate metric
differed. Since updating the committed reference baselines wasn't asked for and the diff was pure
noise, `git checkout -- eval/runs/baseline.json eval/runs/exact.json eval/runs/filtered.json
eval/REPORT.md` restored them to their committed state. Working tree is otherwise clean except the
deliberate schema/migration/script additions above and the `app/api/lookup/route.ts` shadow-log
diff — all uncommitted, per the user's "design and write code only" decision.

**Not run this session, per the user's explicit choice:** the ~35-minute Phase E pipeline that
would reproduce CLAUDE.md's full 8-cell headline gloss-vs-lemma table (`cell_lemma_ft`,
`cell_gloss_ft_synset`, etc.). The fast baseline/exact/filtered numbers above are what's validated;
the headline table's absolute numbers remain unverified on this machine, though nothing found this
session gives any reason to doubt them.

---

## Phase 4 — How the embedding model actually works, end to end

### What `franzclarin/ReverseDictionary` is

It's a **sentence-embedding model**, not a text-generation model — it has no decoder, so it cannot
write a sentence, definition, or answer. What it does is map any string of text (a query, a word,
a gloss) to a single 384-dimensional vector such that texts with similar *meaning* end up as
nearby vectors — nearness measured by cosine similarity. Search then becomes "find the vector
closest to the query's vector," not "ask the model for an answer."

It started as a general-purpose sentence-transformer base model and was **fine-tuned** on 181,149
`(gloss, lemma, negative-lemma)` triplets drawn from WordNet — i.e., for each dictionary
definition, the model was shown the real word it defines plus a wrong word, and trained to pull
the gloss's vector closer to the real word's vector than to the wrong one's. The loss function was
`MultipleNegativesRankingLoss` (a standard contrastive/ranking loss for exactly this "which of
these candidates matches" setup), run for 3 epochs. **Critically, this fine-tune had no held-out
evaluation split** — the training config used `eval_on_start: False` and
`prediction_loss_only: True`, so the only number ever reported (10.9% at training time) describes
how well the model memorized its own training triplets, not how it generalizes. That figure is
explicitly called out in CLAUDE.md as unusable and not to be cited — which is the whole reason
this repo built its own offline eval harness from scratch, on a hand-authored query set the model
could not have seen.

### How a query becomes a vector (`lib/embedder.ts`)

1. `embed(query)` calls into `franzclarin/ReverseDictionary`, loaded on-demand via Transformers.js
   (an ONNX runtime, `env("@xenova/transformers")`) — this is the model running inside the
   Node.js server function itself, not a call out to a hosted inference API.
2. The model's raw output is one vector *per token* of the input text (this is a transformer —
   "the smell of rain on dry earth" produces several token-level vectors, not one).
3. **Mean pooling** collapses those token vectors into a single vector by averaging them
   element-wise. This is a deliberate architectural choice, not the only option (some models
   instead take the first token's vector, a la BERT's `[CLS]`) — mean pooling is what the original
   sentence-transformers pipeline that produced the stored database vectors used, so query vectors
   have to be pooled the same way or they'd live in a different space than what's stored.
4. **L2 normalization** rescales the pooled vector to unit length. This is what makes cosine
   similarity and Euclidean distance equivalent for ranking purposes, and it's why pgvector's
   `<=>` operator (cosine distance) is the right comparison operator here.
5. The result is a plain 384-number array — that's the entire "understanding" of the query as far
   as retrieval is concerned. There's no reasoning step, no re-reading of the query, no attention
   to what "top-k" results might mean; it's one forward pass through the network.

A subtlety worth naming: the model is loaded once per warm server instance (`globalThis.
_embedderPromise`) and the code is careful to clear that cached promise if loading ever fails, so
one bad network blip on cold start doesn't permanently wedge every future request on that instance
into repeating the same failure. This is an operational safeguard, not part of how the *model*
works, but it's easy to mistake for a modeling detail when reading the logs.

### How the vector is compared against the vocabulary (pgvector)

`VocabEmbedding` holds one row per word in the ~141,854-word vocabulary — **each row is that
single word's own embedding**, computed the same way (mean pooling + normalize) and stored ahead
of time. The `/api/lookup` route:

1. Embeds the incoming query exactly as above.
2. Runs `SELECT word, 1 - (embedding <=> $1::vector) AS similarity FROM "VocabEmbedding" ORDER BY
   embedding <=> $1::vector LIMIT $2` inside a transaction that first sets
   `SET LOCAL ivfflat.probes = 10`.
3. `<=>` is pgvector's cosine-distance operator; `1 - distance` turns it into a similarity score
   in the more intuitive "higher is more similar" direction for display.
4. The `ORDER BY ... LIMIT` isn't a brute-force scan of all 141,854 rows — it uses `VocabEmbedding`'s
   IVFFlat index, an *approximate* nearest-neighbor structure that partitions the vector space into
   `lists = 150` clusters and only searches the `probes = 10` clusters closest to the query,
   trading a small amount of recall for a large amount of speed. (CLAUDE.md's own measurement:
   this approximation costs about 0.3 points of Recall@1 versus an exact sequential scan — small,
   and not where the model's real limitations live.)

That's the entire live-serving path: embed the query once, compare it against 141,854 pre-computed
single-word vectors via an approximate cosine-similarity search, return the closest matches. There
is no reranking step, no second model, and — as of the 2026-08-18 removal — no Claude call
anywhere in this flow.

### What this setup can't do, and why (the documented limitations)

- **It's matching a sentence against single words, not against definitions.** `VocabEmbedding`
  stores the embedding of the *bare lemma itself* (e.g. the word "petrichor," not its definition)
  — confirmed by CLAUDE.md's probe showing `cos(embed(word), stored[word]) = 1.000000` for 24
  sample words. So a 12-word description is being compared against a single token's vector, which
  is a much easier representation to be *close* to by surface form than by meaning.
- **This produces "lexical echo":** 34.4% of top-10 results for a query like "rain" share a word
  stem with the query itself ("raininess," "rainstorm," "raindrop") rather than actually answering
  the description. These echo results score *higher* on average (+0.134 cosine) than the actual
  intended target word, meaning the model is frequently rewarding surface overlap over semantic
  match — which is the single largest, most structural limitation this repo has measured.
- **The fine-tune barely helped.** Comparing the fine-tuned model against the untouched base model
  on the same lemma-index setup showed only a +4.5-point improvement in lenient Recall@1 — below
  the pre-committed 6-point bar for calling it a real win, so CLAUDE.md treats it as a null result.
- **Indexing *gloss* text instead of bare lemmas is the fix that actually worked**, in offline
  testing: switching what's stored (definitions per WordNet sense, collapsed one row per synset,
  rather than one row per bare word) improved lenient Recall@1 by +12.9 to +15.7 points depending
  on model, and cut the echo rate from ~44% down to ~14% — roughly three times the size of the
  fine-tune's own contribution. This is exactly the "Next steps" item this session designed (but
  did not apply) the migration and population script for.
- **None of this is deployed yet.** Production today still runs the original bare-lemma
  `VocabEmbedding` setup described above — the gloss-indexing improvement exists only as measured
  offline-eval numbers and, as of this session, unapplied migration/script code, not as anything a
  live user query touches.

---

## Session summary — status as of 2026-08-22

**Migration verified working end-to-end.** Toolchain installed (Node 26.7.0/npm via Homebrew,
user ran the sudo-requiring installer step themselves), `npm install`/`tsc --noEmit`/`npm run lint`
all clean, `.env.local` provisioned via `vercel login` (user) + `vercel link`/`env pull` (this
session), and the fast eval suite (`eval`/`eval:exact`/`eval:filtered`/`eval:report`) reproduces
CLAUDE.md's documented baseline/exact numbers exactly against the live production database.

**Scoped and designed both of CLAUDE.md's "Next steps" items**, confirming neither had any
existing code. Wrote, but deliberately left unapplied/undeployed:
- `GlossEmbedding` schema + migration + `scripts/build-gloss-index.ts` (production synset-gloss
  index). Hard-stopped at: the `DROP INDEX` on `VocabEmbedding` (commented out) and running the
  population script's insert phase against production `DATABASE_URL` (only `--dry-run` is safe,
  and even that wasn't run — no reason to burn a ~114k-embedding pass just to prove the code parses).
- `ShadowLookup` schema + migration + `lib/shadowLookup.ts` + a fire-and-forget hook in
  `app/api/lookup/route.ts` (behind a hardcoded `SHADOW_LOOKUP_ENABLED = false` kill switch) +
  `scripts/shadow-compare.ts` (production shadow-log cutover gate). Not applied to any database,
  not committed, not pushed — per the user's explicit "design and write code only" choice.

**Nothing production-facing changed.** No migration ran against Neon, no index was dropped, the
frozen eval set was never touched, and no model weights were touched. The three named hard-stops
were respected throughout.

**What's left, for the user to decide (not this session):**
1. Review the uncommitted diff (`git status` / `git diff`) for the gloss-index and shadow-log
   code — decide whether either should actually be applied/committed/deployed.
2. If proceeding with the gloss index: run `scripts/build-gloss-index.ts --dry-run` first (not yet
   done — blocked on nothing now that `.env.local` exists, just not run), then decide when to
   cross the `DROP INDEX` / production-insert hard-stop.
3. If proceeding with shadow logging: decide the real `SHADOW_SAMPLE_RATE`, review
   `lib/shadowLookup.ts`'s privacy posture (hash-only, top-1-only), then apply the migration and
   flip `SHADOW_LOOKUP_ENABLED`.
4. Optional: the five stale docs (`ARCHITECTURE.md`, `DEPLOYMENT.md`, `GETTING_STARTED.md`,
   `SETUP.md`, `README.md`) still describe the old Claude-based app — a rewrite pass was flagged
   in Phase 0 but is out of scope for this audit.
5. Optional: run the ~35-minute Phase E pipeline if reproducing the full 8-cell headline table on
   this machine specifically is ever needed.

**Follow-up:** at the user's request, removed CLAUDE.md's `### Next steps` section (the three
bullets: synset-gloss-index build, the settled `halfvec(256)` guidance, and the shadow-log-gated
cutover question). Matches this repo's established pattern (see commit `671621c`, "Drop the Open
items section from CLAUDE.md" — delete cleanly rather than leaving a stale/completed checklist,
since it loads into context every session). No information lost: the `halfvec(256)` fact was
already stated in the "Headline results" bullets (CLAUDE.md line 176), and the two actionable
items are now tracked here — this file, plus the uncommitted `GlossEmbedding`/`ShadowLookup`
schema, migrations, and scripts described above — rather than as an open TODO in CLAUDE.md.

---

## Phase 5 — RD-01 executed: production gloss index built (2026-08-26)

**Plan change from the original ticket: user upgraded their Neon plan, so the `DROP INDEX` on
`VocabEmbedding`'s IVFFlat index — the step that freed ~230MB under the old 512MB free-tier
ceiling — was explicitly skipped this run.** `VocabEmbedding` and its index are untouched.

1. **Pre-check:** `pg_database_size` = **460 MB** before starting.
2. **Migration applied:** `prisma/migrations/20260822000000_add_gloss_embeddings/migration.sql`
   via `npx prisma db execute --file` (Prisma CLI needs `DATABASE_URL` exported manually — it
   doesn't read `.env.local` itself). The file's `DROP INDEX` line was already isolated as a single
   commented-out line under a `*** HARD STOP ***` banner, so running the file as-is applied only
   `CREATE TABLE "GlossEmbedding"` + its two indexes. Confirmed not executed.
3. **Population script run, twice:**
   - **Run 1** (unmodified `scripts/build-gloss-index.ts`): embedded all 117,791 synsets cleanly
     (504s), then the insert phase failed immediately with `Can't reach database server` —
     transient Neon connection drop, most likely the compute idling/suspending during the ~8.4min
     embed-only phase (zero DB traffic). Confirmed 0 rows written (upsert never got a first batch
     through), so nothing to clean up.
   - **Run 2** (same script): embedding succeeded again, insert phase started but measured at
     **~90s per 500-row batch** — the loop ran 500 sequential single-row `$executeRawUnsafe` calls
     per batch inside one `$transaction`, so each row paid a full Neon round-trip. Projected to
     **~6 hours** for all 117,791 rows, nowhere near the ticket's ~35min estimate. Flagged to the
     user rather than letting a multi-hour job run unattended; user chose to fix the script rather
     than wait or abandon.
   - **Fix applied to `scripts/build-gloss-index.ts`:** rewrote the batch-insert loop to build one
     multi-row `INSERT ... VALUES (...), (...), ...` statement per 500-row batch instead of 500
     separate statements — collapses 500 round-trips/batch to 1. **This edit is uncommitted** (the
     script itself was committed in `50c83c2`); left for the user to review/commit.
   - **Run 3** (patched script): killed run 2 first (`kill` on the process group — confirmed via
     `ps`), verified the partial 6,500 rows already written were harmless (idempotent upsert on
     `synsetKey`), reran from scratch. Completed cleanly: **117,791/117,791 rows inserted**, total
     wall time roughly embed (~6min) + insert (~15-20min based on observed batch rate) — a large
     improvement over the ~6hr projection, though still slower than the ticket's ~35min estimate
     (likely payload size per multi-row statement, not round-trip count, is now the bottleneck —
     not investigated further since it finished in reasonable time).
4. **Row count:** `GlossEmbedding` has **117,791 rows**, not the ticket's expected ~114,662
   (+2,732, +2.7%). The script's own drift check fired (`NOTE: expected ~114,662 ... got 117,791`)
   and attributed it to possible `wordnet-db` version drift, consistent with CLAUDE.md's caveat
   that the production build (full WordNet lemma set) isn't expected to match the Phase E eval
   pool exactly. Not investigated further per the ticket's own framing ("not necessarily wrong").
5. **Self-retrieval spot checks** (ad hoc script, not committed — see below): sampled 60 random
   probes per table, embedded each probe's own indexed text, queried pgvector, checked rank-1.
   - `VocabEmbedding`: **59/60** — one miss. This table was never touched this session; consistent
     with CLAUDE.md's own measured ~0.3-point recall cost from the approximate IVFFlat index, not
     a regression from anything done here.
   - `GlossEmbedding`: **60/60**, meeting the ticket's 59–60/60-by-synset acceptance bar.
6. **Post-build `pg_database_size`: 673 MB** (`VocabEmbedding` 451MB, `GlossEmbedding` 213MB) —
   materially higher than the ticket's original ~452MB math, exactly as expected once the
   `DROP INDEX` step is skipped (the ticket's own math assumed that ~230MB was freed). **Not
   verified against the new Neon plan's actual cap** — no Neon CLI (`neonctl`) available and
   `npx vercel usage` returned `Error: Costs not found (404)` for this project, so the real ceiling
   number couldn't be pulled programmatically this session. User should confirm 673MB is
   comfortably within whatever the upgraded plan's limit is.
7. **`VocabEmbedding` integrity confirmed directly**, not just assumed from "we never touched it":
   `VocabEmbedding_embedding_ivfflat_idx` still exists (`pg_indexes` query) and `EXPLAIN` on an
   `ORDER BY embedding <=> ...` query shows `Index Scan using "VocabEmbedding_embedding_ivfflat_idx"`
   — not a sequential scan.

**What's uncommitted after this session:**
- `scripts/build-gloss-index.ts` — the multi-row-insert performance fix (functional change, not
  applied in the commit that introduced the script).
- The ad hoc verification scripts used for steps 5–7 above were written to a scratch directory
  (`scripts/scratch_tmp/`) and deleted after use — not part of the permanent `scripts/` tree, per
  instruction not to leave temporary files behind. Their logic is fully described above/in this
  log if they need to be reproduced.

**Not done, out of scope for this ticket (RD-01 only populates data):** `/api/lookup` still queries
`VocabEmbedding` exclusively. No route code was touched. That's RD-02.

---

## Phase 6 — RD-02 started: shadow logging live in production (2026-08-27)

Picked up from a partial start: `SHADOW_LOOKUP_ENABLED` had already been flipped to `true` locally
(uncommitted) but nothing was deployed and the `ShadowLookup` table didn't exist yet — verified
directly (`to_regclass('"ShadowLookup"')` returned null before this phase).

1. Fixed stale "NOT YET ENABLED"/"NOT YET CALLED"/"NOT YET RUNNABLE" comments in
   `app/api/lookup/route.ts`, `lib/shadowLookup.ts`, `scripts/shadow-compare.ts` — all three still
   described the pre-RD-01 dormant state.
2. Applied `prisma/migrations/20260822000001_add_shadow_lookup/migration.sql` to production Neon
   via `prisma db execute --file`. Confirmed via `to_regclass` before/after.
3. Committed in two pieces: `09f0be6` (RD-01 leftover — the multi-row-insert perf fix to
   `scripts/build-gloss-index.ts`, functionally already validated during RD-01's Run 3 but never
   committed) and `d217c99` (the actual RD-02 change — `SHADOW_LOOKUP_ENABLED = true` +
   comment fixes). Pushed to `main` (`fc67f21..d217c99`).
4. Vercel auto-deployed (`reverse-dictionary-gvaf4proc-...`, confirmed `Ready` via
   `vercel inspect --wait`), live on the production aliases including
   `www.reversedictionary.xyz`.
5. Sent 30 test queries against the live `/api/lookup` endpoint — all HTTP 200, no user-facing
   regression. Queried `ShadowLookup` directly afterward: **2 new rows**, consistent with the 10%
   sample rate over 30 requests. Both rows had sensible-looking `oldTop1`/`newTop1`/similarity
   values and `agree: false` — the write path works end to end. A shadow-log failure would mean no
   row gets written (wrapped in `.catch()`), so rows landing is direct evidence of success, not
   just an inference from "no error thrown."

**RD-02's soak period starts now (2026-08-27).** Per the ticket, this needs real elapsed time —
"a few hundred sampled queries at minimum, across normal daily/weekly traffic patterns, not a
single afternoon" — which cannot be compressed by running more requests from this session; that
would just be synthetic traffic, not the real-usage signal the soak is measuring. Once enough
traffic has accumulated:

- Run `npx tsx scripts/shadow-compare.ts` (optionally `--since <date>` to scope to the soak window).
- Read the disagreement sample by hand — qualitative review, not just the headline agreement rate.
- Decide: cut over / hold / iterate, and fill in the ticket's decision-record template
  (`backlog/02-embedding-cutover.html`).
- If cutting over: swap `app/api/lookup/route.ts`'s primary query from `VocabEmbedding` to
  `GlossEmbedding`, keep `VocabEmbedding` live as the rollback path, and only remove the old code
  path in a later follow-up.

**Not done this phase, deliberately:** the soak wait itself, running `shadow-compare.ts` for real
(would report on 2 synthetic rows, not a meaningful sample), and the cutover decision. All three
depend on calendar time this session cannot manufacture.

---
