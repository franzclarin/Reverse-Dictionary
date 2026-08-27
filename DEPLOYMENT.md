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

`VocabEmbedding` (141,854 pre-computed word embeddings) is a data seed, not something any migration or `npm install` step generates — see CLAUDE.md if you're standing this app up against a fresh database.

### Step 4 — Deploy

**Push to `main`.** Vercel's Git integration clones the repo, so `.gitignore` applies and the build only includes what's actually tracked.

**Do not run `vercel deploy --prod` from the CLI.** It uploads the working directory as-is, and `.gitignore` does not apply to CLI deploys (there's no `.vercelignore` in this repo either) — it will sweep in the gitignored `reverse_dict_model.zip` / `_model_tmp/` (~1.5GB) and blow Vercel's 100MB per-file cap. This has been hit before; always deploy by pushing.

### Step 5 — Verify

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
- A cold-start model download can legitimately take up to ~20s; `maxDuration = 60` accounts for this, so a genuine timeout points at a network problem reaching the Hugging Face CDN, not a slow-but-working load.

### Search is slow
- Confirm you're comparing against production latency (both embed and DB round-trips happen inside `iad1`), not a local-machine-to-Neon round trip during dev, which is much slower and not representative — see CLAUDE.md's eval-harness latency note.

## Scaling Considerations

- **Storage ceiling**: the Neon project is capped at 512MB; `VocabEmbedding` alone is ~452MB. There is no headroom for a second full-size vector index without dropping something first — see CLAUDE.md if you're considering the staged `GlossEmbedding` cutover.
- **No rate limiting** — search is fully anonymous and unthrottled. If traffic ever warrants it, this is new infrastructure to add, not a config flip (Upstash/Clerk were removed 2026-08-26, see CLAUDE.md).
