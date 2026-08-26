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
- **Saved collection**: authenticated users can save words to a personal collection.
- **Credits & leaderboard**: users earn credits for saving new words; `/api/leaderboard` ranks the top 10 by credits.
- **Rate limiting**: 50 lookups/day for guests, 200/day for signed-in users, backed by Upstash Redis — fails open if the limiter itself is unreachable.
- **Auth**: sign in with Clerk to unlock the higher limit, saved words, and credits.
- **Share**: copy link or share results directly to X.

## Tech Stack

- **Framework**: Next.js 14 (App Router)
- **Language**: TypeScript
- **Styling**: Tailwind CSS
- **Search**: a fine-tuned sentence-embedding model (`franzclarin/ReverseDictionary`), run in-function via Transformers.js (ONNX) — no external inference API, no generative AI dependency
- **Database**: Neon Postgres + `pgvector`, via Prisma 5
- **Auth**: Clerk (`@clerk/nextjs` v5)
- **Rate Limiting**: Upstash Redis (Vercel Marketplace) + `@upstash/ratelimit`
- **Deployment**: Vercel

For how the retrieval model actually works, its measured limitations, and the offline evaluation harness, see **[CLAUDE.md](CLAUDE.md)** — it's the maintained source of truth for the search internals.

## A note on search quality

`VocabEmbedding` stores the embedding of each bare word, not a definition — so a multi-word description is compared against single-token vectors. This produces a well-documented "lexical echo" effect (results that share a word stem with the query tend to outscore the actual answer). Measured Recall@1 on a hand-authored 287-query eval set is ~10% strict / ~10-11% lenient at the approximate index — see CLAUDE.md's "Headline results" for the full numbers, including an experimental gloss-indexed approach that measured +13-16 points better offline but is not yet in production.

## Getting Started

### Prerequisites

- Node.js 18+
- A Postgres database with the `pgvector` extension (this project uses [Neon](https://neon.tech))
- A Clerk account ([dashboard.clerk.com](https://dashboard.clerk.com/))
- Optional: an Upstash Redis database (Vercel Marketplace `upstash/upstash-kv`) for rate limiting — the app runs without it, just unlimited

### Installation

1. Clone the repository and install dependencies:
```bash
git clone https://github.com/franzclarin/Reverse-Dictionary.git
cd Reverse-Dictionary
npm install
```

2. Create `.env.local` with the variables below. If the project is already linked to Vercel, `vercel env pull .env.local` is the fastest way to get real values.

3. Apply migrations. Neon's pooled connection breaks `prisma migrate deploy`'s advisory lock, so apply the SQL directly instead:
```bash
npx prisma db execute --file prisma/migrations/<migration>/migration.sql
```
(`VocabEmbedding` itself — 141,854 rows of pre-computed embeddings — is a data migration, not something `npm install` seeds; see CLAUDE.md if you're standing up a fresh database.)

4. Run the development server:
```bash
npm run dev
```

5. Open [http://localhost:3000](http://localhost:3000).

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `DATABASE_URL` | Postgres (Neon) connection string, `pgvector` enabled | Yes |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk publishable key | Yes |
| `CLERK_SECRET_KEY` | Clerk secret key | Yes |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Upstash Redis REST creds (written by the Vercel Marketplace integration) | No — rate limiting fails open without it |
| `NEXT_PUBLIC_SITE_URL` | Canonical origin for the sitemap | No — falls back to the production domain |

`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` are read as a fallback if the `KV_*` pair isn't set, but shouldn't be hand-set for a Marketplace-provisioned database — see CLAUDE.md's "Redis creds come from `KV_*`" note.

## Project Structure

```
Reverse-Dictionary/
├── app/
│   ├── api/
│   │   ├── lookup/route.ts           # Search: embed query → pgvector → top-k
│   │   ├── word/[word]/route.ts      # Word page data (existing row or minimal stub)
│   │   ├── word/[word]/save/route.ts # Save/unsave, awards credits
│   │   ├── credits/route.ts          # GET balance, POST award
│   │   └── leaderboard/route.ts      # Top 10 by credits
│   ├── word/[word]/page.tsx          # Word detail page + related words
│   ├── search/page.tsx               # Results list (owns the /api/lookup call)
│   ├── collection/page.tsx           # Saved words
│   ├── sign-in/ , sign-up/           # Clerk auth pages
│   ├── sitemap.ts
│   ├── layout.tsx                    # Root layout (ClerkProvider)
│   └── page.tsx                      # Landing / search entry
├── components/
│   ├── SearchInput.tsx, SearchResults.tsx, ResultListItem.tsx
│   ├── Navbar.tsx, WordLink.tsx, WordShareButtons.tsx
│   ├── SaveWordButton.tsx, CollectionGrid.tsx
├── lib/
│   ├── embedder.ts                   # Transformers.js singleton (the ONNX model)
│   ├── wordData.ts                   # getWordData / getRelatedWords (React cache())
│   ├── prisma.ts                     # Singleton PrismaClient
│   ├── credits.ts                    # Credit award logic
│   └── errors.ts                     # SubsystemError / describeError for fetch-failed triage
├── prisma/
│   └── schema.prisma                 # Word, SavedWord, User, Lookup, GameRound, VocabEmbedding, …
├── scripts/, eval/                   # Offline retrieval evaluation harness (dev-only, read-only)
└── middleware.ts                     # Clerk middleware (all routes public)
```

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

Returns `429` when the rate limit is exceeded, and a `{ error, subsystem, code, detail }` shape on failure — see CLAUDE.md's "Conventions & gotchas" for why a bare `fetch failed` is never the real error here.

### GET /api/word/[word]

Returns related words (nearest neighbours by embedding) and whatever `Word` row exists for the page — text fields are empty for words that haven't been profiled.

### POST / DELETE /api/word/[word]/save

Saves or unsaves a word for the authenticated user. Saving a *new* word awards credits. Requires auth.

### GET / POST /api/credits

Returns or awards the authenticated user's credit balance.

### GET /api/leaderboard

Top 10 users by credits, with display names resolved via Clerk.

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

## Deployment

**Deploy by pushing to `main`** — Vercel's Git integration is the only supported path. `vercel deploy --prod` uploads the working directory directly and ignores `.gitignore`, which sweeps in a ~1.5GB gitignored model artifact and blows Vercel's per-file cap. See [DEPLOYMENT.md](DEPLOYMENT.md).

## License

MIT
