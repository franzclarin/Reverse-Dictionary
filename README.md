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

For how the retrieval model actually works, its measured limitations, and the offline evaluation harness, see **[CLAUDE.md](CLAUDE.md)** — it's the maintained source of truth for the search internals.

## A note on search quality

`VocabEmbedding` stores the embedding of each bare word, not a definition — so a multi-word description is compared against single-token vectors. This produces a well-documented "lexical echo" effect (results that share a word stem with the query tend to outscore the actual answer). Measured Recall@1 on a hand-authored 287-query eval set is ~10% strict / ~10-11% lenient at the approximate index — see CLAUDE.md's "Headline results" for the full numbers, including an experimental gloss-indexed approach that measured +13-16 points better offline but is not yet in production.

## Getting Started

### Prerequisites

- Node.js 18+
- A Postgres database with the `pgvector` extension (this project uses [Neon](https://neon.tech))

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
| `NEXT_PUBLIC_SITE_URL` | Canonical origin for the sitemap | No — falls back to the production domain |

## Project Structure

```
Reverse-Dictionary/
├── app/
│   ├── api/
│   │   ├── lookup/route.ts           # Search: embed query → pgvector → top-k
│   │   └── word/[word]/route.ts      # Word page data (existing row or minimal stub)
│   ├── word/[word]/page.tsx          # Word detail page + related words
│   ├── search/page.tsx               # Results list (owns the /api/lookup call)
│   ├── sitemap.ts
│   ├── icon.svg                      # Favicon (Next App Router file convention)
│   ├── layout.tsx                    # Root layout
│   └── page.tsx                      # Landing / search entry
├── components/
│   ├── SearchInput.tsx, SearchResults.tsx, ResultListItem.tsx
│   ├── Navbar.tsx, WordLink.tsx, WordShareButtons.tsx
├── lib/
│   ├── embedder.ts                   # Transformers.js singleton (the ONNX model)
│   ├── wordData.ts                   # getWordData / getRelatedWords (React cache())
│   ├── prisma.ts                     # Singleton PrismaClient
│   └── errors.ts                     # SubsystemError / describeError for fetch-failed triage
├── prisma/
│   └── schema.prisma                 # Word, VocabEmbedding, GlossEmbedding, ShadowLookup
└── scripts/, eval/                   # Offline retrieval evaluation harness (dev-only, read-only)
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

## Deployment

**Deploy by pushing to `main`** — Vercel's Git integration is the only supported path. `vercel deploy --prod` uploads the working directory directly and ignores `.gitignore`, which sweeps in a ~1.5GB gitignored model artifact and blows Vercel's per-file cap. See [DEPLOYMENT.md](DEPLOYMENT.md).

## License

MIT
