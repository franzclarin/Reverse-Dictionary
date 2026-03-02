# Quick Setup Guide

Follow these steps to get your Reverse Dictionary app running locally.

## Step 1: Get Your Anthropic API Key

1. Go to [https://console.anthropic.com/](https://console.anthropic.com/)
2. Sign up or log in to your account
3. Navigate to API Keys section
4. Create a new API key
5. Copy the key (it starts with `sk-ant-...`)

## Step 2: Configure Environment Variables

1. Create a `.env.local` file in the root of the project:

```bash
# On Windows (Command Prompt)
copy .env.example .env.local

# On Windows (PowerShell)
Copy-Item .env.example .env.local

# On macOS/Linux
cp .env.example .env.local
```

2. Open `.env.local` and add your API key:

```env
ANTHROPIC_API_KEY=sk-ant-your-actual-api-key-here
```

## Step 3: Run the Development Server

```bash
npm run dev
```

The app will be available at [http://localhost:3000](http://localhost:3000)

## Testing the App

1. Open your browser to `http://localhost:3000`
2. Try one of the example queries like "the smell of rain on dry earth"
3. You should see "petrichor" as the result

## Troubleshooting

### Error: "API configuration error"
- Make sure your `.env.local` file exists
- Verify your `ANTHROPIC_API_KEY` is set correctly
- Restart the development server after changing environment variables

### Error: "AI service error"
- Check that your API key is valid
- Ensure you have credits in your Anthropic account
- Verify your internet connection

### Build Errors
- Run `npm install` to ensure all dependencies are installed
- Delete `.next` folder and rebuild: `rm -rf .next && npm run build`

## Next Steps

Once you have the app running locally:

1. Test different queries
2. Customize the UI in `app/page.tsx`
3. Modify the system prompt in `app/api/reverse-dictionary/route.ts`
4. Deploy to Vercel (see README.md for instructions)

## Need Help?

- Check the main [README.md](README.md) for more detailed information
- Review [ARCHITECTURE.md](ARCHITECTURE.md) for system design details
- Open an issue on GitHub if you encounter problems
