# Getting Started Checklist

## Local Development Setup

### 1. Environment Setup

- [ ] Get a Neon Postgres connection string with `pgvector` enabled (or pull it: `npx vercel link && npx vercel env pull .env.local`)
- [ ] Create `.env.local` with `DATABASE_URL` (see [SETUP.md](SETUP.md) — it's the only required variable)

### 2. Run Locally

- [ ] `npm install`
- [ ] `npm run dev`
- [ ] Open [http://localhost:3000](http://localhost:3000)
- [ ] Try a query like "the smell of rain on dry earth" and see what the search returns — don't expect a guaranteed exact match; see the note below

### 3. Verify Build

- [ ] `npm run build` succeeds
- [ ] `npx tsc --noEmit` reports no errors
- [ ] `npm run lint` is clean

## A note on expected search behavior

Unlike the old Claude-powered version of this app, results are **not guaranteed to be the intended word** for a given description. The current model embeds bare words, not definitions, which produces a documented "lexical echo" effect — measured strict Recall@1 is ~10% on a 287-query hand-authored eval set (CLAUDE.md's "Headline results"). If a query doesn't return what you expected, that's the current, known state of retrieval quality — not a bug in your local setup.

## Production Deployment

See [DEPLOYMENT.md](DEPLOYMENT.md) for the full walkthrough. In short:

- [ ] Push to GitHub, import the repo on Vercel
- [ ] Set `DATABASE_URL` in Vercel's environment variables
- [ ] **Deploy by pushing to `main`** — not `vercel deploy --prod` (see DEPLOYMENT.md for why)
- [ ] Verify the deployed URL, checking function logs for `[lookup] embed ok` / `[lookup] db ok`

## Testing Checklist

- [ ] Run a handful of varied queries and confirm results return with similarity scores
- [ ] Test on mobile

## Customization Ideas

- [ ] Adjust the color scheme / typography in `app/globals.css` and `tailwind.config.ts`
- [ ] Change `k` (result count) in `app/api/lookup/route.ts`
- [ ] Customize `components/SearchInput.tsx` / `components/SearchResults.tsx`
- [ ] Update metadata in `app/layout.tsx` and `app/sitemap.ts`'s `NEXT_PUBLIC_SITE_URL` fallback

## Improving Search Quality

This is the actual open problem in this app, not a customization nicety. Start with [CLAUDE.md](CLAUDE.md)'s "Established facts" and "Headline results" sections — a gloss-indexed approach has already been measured offline to fix most of the lexical-echo problem (+13-16 points of lenient Recall@1) and is designed, type-checked, and committed as dormant scaffolding (`GlossEmbedding`/`ShadowLookup` in `prisma/schema.prisma`, `scripts/build-gloss-index.ts`, `scripts/shadow-compare.ts`) — not yet applied to production. That's the highest-leverage next step, not a from-scratch redesign.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| 500 with `subsystem: "database"` | Check `DATABASE_URL`, confirm `pgvector` is enabled and `VocabEmbedding` is populated |
| 500 with `subsystem: "model"` | First request per warm instance downloads the embedding model from the HF CDN — needs outbound network, can take up to ~20s |
| Build fails | `npm install`, then `rm -rf .next && npm run build` |
| `next dev` exits instantly, no server | Check if the repo is under OneDrive or similar cloud sync — see CLAUDE.md's "Repo hygiene" |

## Documentation Reference

- **[README.md](README.md)** — overview, features, API reference
- **[SETUP.md](SETUP.md)** — quick local setup
- **[ARCHITECTURE.md](ARCHITECTURE.md)** — system design
- **[DEPLOYMENT.md](DEPLOYMENT.md)** — deploying to Vercel
- **[CLAUDE.md](CLAUDE.md)** — how retrieval actually works, its measured limitations, and the offline eval harness; the maintained source of truth for search internals

## Project Status

Search and word pages are live in production, fully anonymous — there is no userbase (auth, saved words, credits, leaderboard were removed 2026-08-26). Search quality is a known, measured, ongoing limitation (see above) — not something to report as broken, but also not something to describe as "done." A gloss-indexed retrieval improvement is designed and staged, not yet deployed.
