# Reverse Dictionary

A reverse dictionary powered by a fine-tuned sentence-embedding model. Describe a concept in plain language and search a 141k-word vocabulary for the closest match by meaning.

## Examples

Queries like these are what the app is built for — semantic search over single-word vectors doesn't always nail the exact term (see "A note on search quality" below), but this is the shape of the problem it's solving:

- "the smell of rain on dry earth" → **petrichor**
- "fear of long words" → **hippopotomonstrosesquippedaliophobia**
- "a story told from inside the story" → **diegesis**
- "pleasure derived from others' misfortune" → **schadenfreude**

## Features

- **Semantic search**: a query is embedded and compared against 141,854 pre-computed word vectors via pgvector cosine similarity — no generative model in the loop.
- **Word pages**: each result has a dedicated page at `/word/[word]` with related words (nearest neighbours in embedding space).
- **Share**: copy link or share results directly to X.
- **No auth, no rate limiting**: search is fully anonymous and unthrottled. There is no userbase — no sign-in, saved words, credits, or leaderboard (removed 2026-08-26, see CLAUDE.md).

## Tech Stack

- **Framework**: Next.js 14 (App Router)
- **Language**: TypeScript
- **Styling**: Tailwind CSS
- **Search**: a fine-tuned sentence-embedding model (`franzclarin/ReverseDictionary`), run in-function via Transformers.js (ONNX) — no external inference API, no generative AI dependency
- **Database**: Neon Postgres + `pgvector`, via Prisma 5
- **Deployment**: Vercel

For how the app is put together — system diagram, data flow, project structure — see **[ARCHITECTURE.md](ARCHITECTURE.md)**. For how the retrieval model actually works, its measured limitations, and the offline evaluation harness, see **[CLAUDE.md](CLAUDE.md)** — it's the maintained source of truth for the search internals.

## A note on search quality

`VocabEmbedding` stores the embedding of each bare word, not a definition — so a multi-word description is compared against single-token vectors. This produces a well-documented "lexical echo" effect (results that share a word stem with the query tend to outscore the actual answer). Measured Recall@1 on a hand-authored 287-query eval set is ~10% strict / ~10-11% lenient at the approximate index. If a query doesn't return the word you expected, that's the current, known state of retrieval quality, not a bug in your setup.

A gloss-indexed alternative (embedding WordNet definitions per sense instead of bare words) has already been measured offline to fix most of this (+13-16 points of lenient Recall@1) and is designed, type-checked, and committed as dormant scaffolding (`GlossEmbedding`/`ShadowLookup` in `prisma/schema.prisma`) — not yet applied to production. That's the highest-leverage next step for this app. See CLAUDE.md's "Established facts" and "Headline results" for the full numbers.

## Getting Started

### Prerequisites

- Node.js 18+
- A Postgres database with the `pgvector` extension (this project uses [Neon](https://neon.tech)) — or ask whoever owns this project for the shared dev database

### Installation

1. Clone the repository and install dependencies:
```bash
git clone https://github.com/franzclarin/Reverse-Dictionary.git
cd Reverse-Dictionary
npm install
```

2. Create `.env.local` — `DATABASE_URL` is the only required variable (see "Environment Variables" below). If this project is already linked to a Vercel team, the fastest path is to pull real values directly:
```bash
npx vercel login
npx vercel link
npx vercel env pull .env.local
```

3. If you're standing this app up against a genuinely fresh database, apply migrations. Neon's pooled connection breaks `prisma migrate deploy`'s advisory lock, so apply the SQL directly instead:
```bash
npx prisma db execute --file prisma/migrations/<migration>/migration.sql
```
`postinstall` runs `prisma generate` automatically, and you don't need this step at all against a database that already has the schema applied. `VocabEmbedding` itself — 141,854 rows of pre-computed embeddings — is a data seed, not something a migration or `npm install` generates for you; see CLAUDE.md if you need to rebuild it.

4. Run the development server:
```bash
npm run dev
```

5. Open [http://localhost:3000](http://localhost:3000) and try a query like "the smell of rain on dry earth" — see "A note on search quality" above for what to expect from the result.

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `DATABASE_URL` | Postgres (Neon) connection string, `pgvector` enabled | Yes |
| `NEXT_PUBLIC_SITE_URL` | Canonical origin for the sitemap | No — falls back to the production domain |

There's no `.env.example` checked in — the table above is the complete set.

## API Reference

### POST /api/lookup

Request:
```json
{ "query": "the smell of rain on dry earth", "k": 10 }
```

Response:
```json
{
  "results": [{ "word": "petrichor", "similarity": 0.71 }, ...],
  "timingMs": 812
}
```

Returns a `{ error, subsystem, code, detail }` shape on failure — see CLAUDE.md's "Conventions & gotchas" for why a bare `fetch failed` is never the real error here.

### GET /api/word/[word]

Returns related words (nearest neighbours by embedding) and whatever `Word` row exists for the page — text fields are empty for words that haven't been profiled.

## Development

```bash
npm run dev            # Start development server
npm run build           # Build for production
npm start                # Start production server
npm run lint             # Run ESLint
npx tsc --noEmit         # Type-check
npx prisma studio        # Browse the database

npm run eval              # Offline retrieval eval — see CLAUDE.md "Evaluation"
```

### Customization

- Adjust the color scheme / typography in `app/globals.css` and `tailwind.config.ts`
- Change `k` (result count) in `app/api/lookup/route.ts`
- Customize `components/SearchInput.tsx` / `components/SearchResults.tsx`
- Update metadata in `app/layout.tsx` and `app/sitemap.ts`'s `NEXT_PUBLIC_SITE_URL` fallback

### Troubleshooting

| Issue | Solution |
|-------|----------|
| 500 with `subsystem: "database"` | Check `DATABASE_URL`, confirm `pgvector` is enabled and `VocabEmbedding` is populated |
| 500 with `subsystem: "model"` | First request per warm instance downloads the embedding model from the HF CDN — needs outbound network, can take up to ~20s |
| Build fails | `npm install`, then `rm -rf .next && npm run build` |
| `next dev` exits instantly, no server | Check if the repo is under OneDrive or similar cloud sync — see CLAUDE.md's "Repo hygiene" |

## Deployment

**Deploy by pushing to `main`** — Vercel's Git integration is the only supported path. `vercel deploy --prod` uploads the working directory directly and ignores `.gitignore`, which sweeps in a ~1.5GB gitignored model artifact and blows Vercel's per-file cap. See **[DEPLOYMENT.md](DEPLOYMENT.md)** for the full walkthrough, production troubleshooting, and scaling notes.

## Documentation

- **README.md** (this file) — overview, local setup, API reference
- **[ARCHITECTURE.md](ARCHITECTURE.md)** — system design, data flow, project structure
- **[DEPLOYMENT.md](DEPLOYMENT.md)** — deploying to Vercel, monitoring, troubleshooting production
- **[CLAUDE.md](CLAUDE.md)** — how retrieval actually works, its measured limitations, and the offline eval harness; the maintained source of truth for search internals

## License

MIT
