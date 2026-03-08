# Reverse Dictionary

A reverse dictionary powered by Claude AI. Describe a concept in plain language and discover the exact word you're looking for.

## Examples

- "the smell of rain on dry earth" → **petrichor**
- "fear of long words" → **hippopotomonstrosesquippedaliophobia**
- "a story told from inside the story" → **diegesis**
- "pleasure derived from others' misfortune" → **schadenfreude**

## Features

- **AI-Powered Search**: Uses Claude Sonnet 4 for accurate word matching
- **Word Pages**: Each result has a dedicated SEO-optimized page at `/word/[word]`
- **Saved Collection**: Authenticated users can save words to a personal collection
- **Credits System**: Earn credits through daily lookups, streaks, and saving words
- **Word Games**: Five casino-style games — Word Roulette, Definition Bluff, Lexical Slots, Higher or Lower, Speed Round
- **Leaderboard**: Top 10 credit rankings across all users
- **Rate Limiting**: 3 lookups/day for guests, 50/day for signed-in users
- **Auth**: Sign in with Clerk to unlock higher limits, word saving, and games
- **Share**: Copy link or share results directly to X

## Tech Stack

- **Framework**: Next.js 14 (App Router)
- **Language**: TypeScript
- **Styling**: Tailwind CSS
- **AI**: Anthropic Claude API (`claude-sonnet-4-20250514`)
- **Auth**: Clerk (`@clerk/nextjs` v5)
- **Rate Limiting**: Upstash Redis + `@upstash/ratelimit`
- **Database**: PostgreSQL via Prisma v5
- **Deployment**: Vercel

## Getting Started

### Prerequisites

- Node.js 18+
- An Anthropic API key ([console.anthropic.com](https://console.anthropic.com/))
- A Clerk account ([dashboard.clerk.com](https://dashboard.clerk.com/))
- An Upstash Redis database ([console.upstash.com](https://console.upstash.com/))
- A PostgreSQL database

### Installation

1. Clone the repository:
```bash
git clone https://github.com/yourusername/reverse-dictionary.git
cd reverse-dictionary
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.env.local` file and add your environment variables (see below).

4. Run the Prisma migration:
```bash
npx prisma db push
```

5. Run the development server:
```bash
npm run dev
```

6. Open [http://localhost:3000](http://localhost:3000) in your browser.

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `ANTHROPIC_API_KEY` | Anthropic API key | Yes |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk publishable key | Yes |
| `CLERK_SECRET_KEY` | Clerk secret key | Yes |
| `DATABASE_URL` | PostgreSQL connection string | Yes |
| `UPSTASH_REDIS_REST_URL` | Upstash Redis REST URL | Yes (rate limiting) |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis REST token | Yes (rate limiting) |
| `GAME_TOKEN_SECRET` | Secret for signing game state tokens | No (recommended) |

## Project Structure

```
reverse-dictionary/
├── app/
│   ├── api/
│   │   ├── reverse-dictionary/
│   │   │   └── route.ts          # Main search endpoint
│   │   ├── word/[word]/
│   │   │   ├── route.ts          # Word profile fetch/generate
│   │   │   └── save/route.ts     # Save/unsave toggle
│   │   ├── credits/
│   │   │   └── route.ts          # GET balance, POST award
│   │   ├── leaderboard/
│   │   │   └── route.ts          # Top 10 credit rankings
│   │   └── games/
│   │       └── [game]/
│   │           └── route.ts      # Game endpoints (5 games)
│   ├── word/[word]/
│   │   └── page.tsx              # SSR word detail page
│   ├── games/
│   │   ├── page.tsx              # Game lobby + leaderboard
│   │   └── [game]/
│   │       └── page.tsx          # Individual game page
│   ├── collection/
│   │   └── page.tsx              # Saved words collection
│   ├── sign-in/[[...sign-in]]/
│   │   └── page.tsx              # Clerk sign-in
│   ├── sign-up/[[...sign-up]]/
│   │   └── page.tsx              # Clerk sign-up
│   ├── sitemap.ts                # Auto-generated sitemap
│   ├── layout.tsx                # Root layout (ClerkProvider)
│   └── page.tsx                  # Main search page
├── components/
│   ├── CreditsDisplay.tsx        # Credits balance in navbar
│   ├── ResultDisplay.tsx         # Search results with word links
│   ├── SaveWordButton.tsx        # Save/unsave toggle (client)
│   └── WordShareButtons.tsx      # Copy link + share on X (client)
├── lib/
│   ├── credits.ts                # Credit award logic + game settlement
│   ├── gameTokens.ts             # HMAC-signed game state tokens
│   ├── gameUtils.ts              # Random words, rate limiting, bet validation
│   ├── prisma.ts                 # Singleton PrismaClient
│   └── wordData.ts               # Word profile: DB cache → Claude
├── prisma/
│   └── schema.prisma             # Word, SavedWord, User, Lookup, GameRound models
└── middleware.ts                 # Clerk middleware (all routes public)
```

## API Reference

### POST /api/reverse-dictionary

Request:
```json
{ "description": "the smell of rain on dry earth" }
```

Response:
```json
{
  "word": "petrichor",
  "definition": "The pleasant smell that accompanies the first rain after a dry spell.",
  "alternatives": ["geosmin"],
  "examples": [
    "The petrichor after the storm was incredibly refreshing."
  ],
  "rateLimit": { "remaining": 49, "limit": 50, "isGuest": false }
}
```

Returns `429` when the rate limit is exceeded.

### GET /api/word/[word]

Returns a full word profile (fetched from DB or generated by Claude).

### POST /api/word/[word]/save

Saves a word to the authenticated user's collection. DELETE removes it. Requires auth.

### GET /api/credits

Returns the authenticated user's current credit balance.

### GET /api/leaderboard

Returns the top 10 users by credits with display names from Clerk.

### POST /api/games/[game]

Plays a round of one of the five games. Available games: `word-roulette`, `definition-bluff`, `lexical-slots`, `higher-lower`, `speed-round`. Requires auth. Bets must be between 10 and 500 credits.

## Development

```bash
npm run dev      # Start development server
npm run build    # Build for production
npm start        # Start production server
npm run lint     # Run ESLint
npx prisma studio  # Browse the database
```

## Deployment (Vercel)

1. Push your code to GitHub and import the repo on [vercel.com](https://vercel.com).
2. Add all environment variables under Settings → Environment Variables.
3. Deploy — Vercel runs `prisma generate` automatically on build.

## License

MIT
