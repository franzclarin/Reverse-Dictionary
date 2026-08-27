# Quick Setup Guide

Follow these steps to get the Reverse Dictionary app running locally.

## Step 1: Get Credentials

You need one thing before the app will run locally:

1. **A Neon Postgres connection string** with `pgvector` enabled ([neon.tech](https://neon.tech)) — or ask whoever owns this project for the shared dev database.

If this project is already linked to a Vercel team, the fastest path is:
```bash
npx vercel login
npx vercel link
npx vercel env pull .env.local
```
which pulls real Development-scoped values for all of the above directly.

## Step 2: Configure Environment Variables

If you're not pulling from Vercel, create `.env.local` in the project root by hand:

```env
DATABASE_URL=postgres://...
```

There's no `.env.example` checked in — the variable names above are the complete required set (see README's Environment Variables table for what each one does).

## Step 3: Install and Run

```bash
npm install
npm run dev
```

The app will be available at [http://localhost:3000](http://localhost:3000).

`postinstall` runs `prisma generate` automatically. You do **not** need to run `prisma migrate` or `prisma db push` against a database that already has the schema applied — `DATABASE_URL` just needs to point at one that does. If you're standing up a genuinely fresh database, see DEPLOYMENT.md's migration step and CLAUDE.md's note that `VocabEmbedding`'s 141,854 rows are a data seed, not something a migration generates for you.

## Testing the App

1. Open `http://localhost:3000`.
2. Try a query like "the smell of rain on dry earth" and see what comes back.
3. Don't be surprised if the intended word isn't the top result — this model's measured strict Recall@1 is ~10% on a 287-query eval set (see CLAUDE.md), largely due to a documented "lexical echo" effect. That's expected current behavior, not a local misconfiguration.

## Troubleshooting

### Search returns a 500 with `subsystem: "database"`
- Confirm `DATABASE_URL` is correct and the database has `pgvector` enabled and a populated `VocabEmbedding` table.

### Search returns a 500 with `subsystem: "model"`
- The embedding model (`franzclarin/ReverseDictionary`) is pulled from the Hugging Face CDN on first use per warm instance — this needs outbound network access on first run and can take up to ~20s.

### Build errors
- Run `npm install` again.
- Delete `.next` and rebuild: `rm -rf .next && npm run build`.
- If `next dev` exits immediately with no server started, check whether the repo lives under a cloud-sync folder (OneDrive, etc.) — see CLAUDE.md's "Repo hygiene" for a known `EINVAL: readlink` issue in that setup.

## Next Steps

- Read [CLAUDE.md](CLAUDE.md) for how search actually works, its measured limitations, and the offline eval harness.
- See [ARCHITECTURE.md](ARCHITECTURE.md) for the full system design.
- Deploying? See [DEPLOYMENT.md](DEPLOYMENT.md) — in particular, deploy by pushing to `main`, not `vercel deploy --prod`.
