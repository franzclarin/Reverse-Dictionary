# Reverse Dictionary

A production-ready reverse dictionary application powered by Claude AI. Describe a concept in plain language and discover the exact word you're looking for.

## Examples

- "the smell of rain on dry earth" → **petrichor**
- "fear of long words" → **hippopotomonstrosesquippedaliophobia**
- "a story told from inside the story" → **diegesis**
- "pleasure derived from others' misfortune" → **schadenfreude**

## Features

- **AI-Powered Search**: Uses Claude Sonnet 4 for accurate word matching
- **Beautiful UI**: Modern, responsive design with dark mode support
- **Fast & Reliable**: Built with Next.js for optimal performance
- **Example Queries**: Pre-loaded examples to get you started
- **Alternative Words**: Suggests related words when applicable
- **Usage Examples**: Shows how to use the word in context

## Tech Stack

- **Framework**: Next.js 14 (App Router)
- **Language**: TypeScript
- **Styling**: Tailwind CSS
- **AI**: Anthropic Claude API (claude-sonnet-4-20250514)
- **Deployment**: Vercel

## Getting Started

### Prerequisites

- Node.js 18+ installed
- An Anthropic API key ([Get one here](https://console.anthropic.com/))

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

3. Create a `.env.local` file in the root directory:
```bash
cp .env.example .env.local
```

4. Add your Anthropic API key to `.env.local`:
```env
ANTHROPIC_API_KEY=your_api_key_here
```

5. Run the development server:
```bash
npm run dev
```

6. Open [http://localhost:3000](http://localhost:3000) in your browser.

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `ANTHROPIC_API_KEY` | Your Anthropic API key | Yes |

## Project Structure

```
reverse-dictionary/
├── app/
│   ├── api/
│   │   └── reverse-dictionary/
│   │       └── route.ts          # Claude API integration
│   ├── layout.tsx                 # Root layout
│   ├── page.tsx                   # Main page
│   └── globals.css                # Global styles
├── components/
│   ├── SearchInput.tsx            # Search input component
│   ├── ResultDisplay.tsx          # Results display
│   └── ExampleQueries.tsx         # Example query chips
├── types/
│   └── index.ts                   # TypeScript types
└── ARCHITECTURE.md                # Architecture documentation
```

## Deployment

### Deploy to Vercel (Recommended)

1. Push your code to GitHub

2. Import your repository to Vercel:
   - Go to [vercel.com](https://vercel.com)
   - Click "Import Project"
   - Select your repository

3. Configure environment variables:
   - Add `ANTHROPIC_API_KEY` in the Vercel dashboard
   - Settings → Environment Variables

4. Deploy:
   - Vercel will automatically deploy your app
   - You'll get a production URL

### Manual Deployment

1. Build the project:
```bash
npm run build
```

2. Start the production server:
```bash
npm start
```

## Usage

1. Enter a description of the concept you're thinking of
2. Click "Find Word" or press Enter
3. View the result with definition and examples
4. Try the example queries for inspiration

## API Reference

### POST /api/reverse-dictionary

Request body:
```json
{
  "description": "the smell of rain on dry earth"
}
```

Response:
```json
{
  "word": "petrichor",
  "definition": "The pleasant smell that accompanies the first rain after a dry spell.",
  "alternatives": ["geosmin"],
  "examples": [
    "The petrichor after the storm was incredibly refreshing.",
    "Nothing beats the petrichor of a summer rain."
  ]
}
```

## Development

- `npm run dev` - Start development server
- `npm run build` - Build for production
- `npm start` - Start production server
- `npm run lint` - Run ESLint

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT License - feel free to use this project for any purpose.

## Credits

- Built with [Next.js](https://nextjs.org/)
- Powered by [Claude AI](https://www.anthropic.com/claude)
- Styled with [Tailwind CSS](https://tailwindcss.com/)

## Support

If you encounter any issues or have questions, please [open an issue](https://github.com/yourusername/reverse-dictionary/issues).
