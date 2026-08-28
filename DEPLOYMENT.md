# Deployment Guide

This app is deployed on **Vercel only**. That isn't just a preference — the search path runs an ONNX embedding model in-function (`serverComponentsExternalPackages: ["@xenova/transformers"]`) and depends on Neon-specific pooled-connection behavior for migrations, neither of which this guide has validated on Railway/Fly/Netlify/etc. If you fork this to another platform, treat the search feature as unverified until you've confirmed both of those independently.

## Deploy to Vercel

### Prerequisites

- A GitHub account, with this repo pushed there
- A Neon Postgres database with the `pgvector` extension enabled

### Step 1 — Import the project

1. Go to [vercel.com](https://vercel.com), sign in with GitHub, and import this repository.
2. Framework preset (Next.js), root directory, build command, and output directory are all auto-detected.

### Step 2 — Environment variables

Add these under Settings → Environment Variables (Production, Preview, and Development as appropriate):

| Variable | Source |
|---|---|
| `DATABASE_URL` | Neon connection string (owner role for migrations; a read-only role is enough for the app itself) |
| `NEXT_PUBLIC_SITE_URL` | Your production domain, if it's not `reversedictionary.xyz` |

### Step 3 — Apply migrations

Neon's pooled connection breaks `prisma migrate deploy`'s advisory lock. Apply migration SQL directly instead:

```bash
npx prisma db execute --file prisma/migrations/<migration-folder>/migration.sql
```

The vector tables are data seeds, not something any migration or `npm install` step generates: `GlossEmbedding` (693,325 sense rows — the table search actually reads: 117,791 WordNet synsets plus 575,534 Wiktionary senses added by RD-17) and `VocabEmbedding` (141,854 bare-lemma rows — related-word lookups plus the search rollback path). See CLAUDE.md if you're standing this app up against a fresh database.

### Step 4 — The build fetches the embedding model

Nothing to configure, but worth knowing before you read a build log: `npm run build` runs
`scripts/fetch-model.mjs` first, which downloads the 86MB ONNX model from the Hugging Face CDN
into `models/` so `next.config.js` can trace it into the `/api/lookup` function (RD-11).

- **A failed fetch fails the build, by design.** `lib/embedder.ts` loads the model with remote
  fetching disabled, so a deploy without it would 500 on every search. Failing at build time is
  the intended outcome — if HF is down, retry the deploy.
- The step verifies exact byte sizes, so a truncated download or an HTML error page served with
  a 200 fails loudly rather than shipping a corrupt model.
- Locally, run `npm run fetch-model` once. It's idempotent (a second run skips in ~50ms), and
  the eval scripts need it too.

### Step 5 — Deploy

**Push to `main`.** Vercel's Git integration clones the repo, so `.gitignore` applies and the build only includes what's actually tracked.

**Do not run `vercel deploy --prod` from the CLI.** It uploads the working directory as-is, and `.gitignore` does not apply to CLI deploys (there's no `.vercelignore` in this repo either) — it will sweep in the gitignored `reverse_dict_model.zip` / `_model_tmp/` (~1.5GB) and blow Vercel's 100MB per-file cap. This has been hit before; always deploy by pushing.

### Step 6 — Verify

1. Open the deployment URL.
2. Run a search and confirm results return (don't expect the top result to always be the "intended" word — see README's note on search quality).
3. Check function logs for `[lookup] embed ok` / `[lookup] db ok` lines confirming both subsystems are healthy.

## Post-Deployment

### Custom Domain

Settings → Domains → add your domain, update DNS as instructed. Also set `NEXT_PUBLIC_SITE_URL` to match, so the sitemap points at the real domain rather than falling back to the default.

### Monitoring

- **Logs**: Vercel's Deployments → function logs. `/api/lookup` logs `embed ok ms=… dims=…`, `db ok ms=… rows=…`, or on failure `[lookup] FAILED subsystem=<model|database|unknown> …` — the subsystem tag is deliberate (see CLAUDE.md's "Tag failures by subsystem") so a generic `fetch failed` never has to be diagnosed blind.

### Updating

```bash
git add <files>
git commit -m "..."
git push
```
Vercel deploys automatically on push to `main`.

## Troubleshooting

### Deployment fails at build
- Check the Vercel build logs.
- Confirm `npx tsc --noEmit` and `npm run build` succeed locally first.

### Search returns a 500
- Check the function log's `subsystem` tag (`model` or `database`) and `code` — see CLAUDE.md's "Observed cause codes" for what `ENOTFOUND`/`ECONNREFUSED`/`EAI_AGAIN` typically mean in this app.
- **A `model` subsystem error no longer means a CDN problem.** Since RD-11 the model is read from the function bundle, not downloaded, so this means the file isn't there — check the build log for the `[fetch-model]` step, and the function log for `[embedder] model loaded … root=…`, which prints the directory it looked in. The usual cause is `outputFileTracingIncludes` in `next.config.js` no longer matching `models/**`.
- Cold start should now be well under a second. If a search takes tens of seconds, something has reverted the embedder to remote loading — that is a regression, not expected behaviour.

### Search is slow
- Confirm you're comparing against production latency (both embed and DB round-trips happen inside `iad1`), not a local-machine-to-Neon round trip during dev, which is much slower and not representative — see CLAUDE.md's eval-harness latency note.

## Scaling Considerations

- **Storage**: the cap **is now verified** — `SHOW neon.max_cluster_size` returns **16TB** (RD-17, 2026-08-28), so the "512MB free-tier ceiling" that shaped RD-01 and RD-02 has not applied for some time. The database sits at **~1.8GB** after RD-17's vocabulary expansion: `GlossEmbedding` ~1,295MB (693,325 rows) plus `VocabEmbedding` ~451MB, both fully indexed. The originally-planned `DROP INDEX` on `VocabEmbedding` was skipped during RD-01 and there is no longer a space argument for revisiting it. **Storage is not the binding constraint on this project; cost and retrieval quality are.**
- **Rebuilding the gloss IVFFlat index needs `SET maintenance_work_mem = '512MB'` in the migration** — Neon's default is 64MB and the build over 693,325 `halfvec(384)` rows at `lists = 833` needs 169MB, failing with `memory required is 169 MB`. `prisma db execute --file` runs the file as one transaction, so a failed `CREATE INDEX` rolls its `DROP INDEX` back and the serving index survives; the failure is safe to retry. The rebuild takes ~76s.
- **No rate limiting** — search is fully anonymous and unthrottled. If traffic ever warrants it, this is new infrastructure to add, not a config flip (Upstash/Clerk were removed 2026-08-26, see CLAUDE.md).
