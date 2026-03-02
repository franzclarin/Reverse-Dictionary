# Deployment Guide

This guide covers deploying your Reverse Dictionary application to production.

## Deploy to Vercel (Recommended)

Vercel is the recommended deployment platform for Next.js applications. It offers zero-configuration deployment with automatic HTTPS, CDN, and serverless functions.

### Prerequisites

- A GitHub account
- Your code pushed to a GitHub repository
- An Anthropic API key

### Step-by-Step Deployment

#### 1. Prepare Your Repository

```bash
# Initialize git if you haven't already
git init

# Add all files
git add .

# Commit your changes
git commit -m "Initial commit: Reverse Dictionary app"

# Create a new repository on GitHub, then push
git remote add origin https://github.com/yourusername/reverse-dictionary.git
git branch -M main
git push -u origin main
```

#### 2. Deploy to Vercel

**Option A: Using Vercel Dashboard**

1. Go to [vercel.com](https://vercel.com) and sign in with GitHub
2. Click "Add New Project"
3. Import your `reverse-dictionary` repository
4. Configure the project:
   - Framework Preset: Next.js (auto-detected)
   - Root Directory: ./
   - Build Command: `npm run build` (auto-detected)
   - Output Directory: `.next` (auto-detected)
5. Add Environment Variables:
   - Click "Environment Variables"
   - Add `ANTHROPIC_API_KEY` with your API key
   - Select all environments (Production, Preview, Development)
6. Click "Deploy"

**Option B: Using Vercel CLI**

```bash
# Install Vercel CLI
npm install -g vercel

# Login to Vercel
vercel login

# Deploy
vercel

# Follow the prompts:
# - Set up and deploy: Y
# - Which scope: [your-username]
# - Link to existing project: N
# - Project name: reverse-dictionary
# - Directory: ./
# - Override settings: N

# Add environment variable
vercel env add ANTHROPIC_API_KEY
# Paste your API key when prompted
# Select all environments

# Deploy to production
vercel --prod
```

#### 3. Verify Deployment

1. Vercel will provide a deployment URL (e.g., `reverse-dictionary.vercel.app`)
2. Open the URL in your browser
3. Test the application with example queries
4. Verify that results are being returned correctly

### Post-Deployment Configuration

#### Custom Domain (Optional)

1. In Vercel Dashboard, go to your project
2. Navigate to Settings → Domains
3. Add your custom domain
4. Update DNS records as instructed
5. Wait for DNS propagation (can take up to 48 hours)

#### Environment Variables Management

To update environment variables:

1. Go to Settings → Environment Variables
2. Edit or add new variables
3. Redeploy for changes to take effect

#### Monitoring

Vercel provides built-in monitoring:

1. Analytics: Track page views and performance
2. Logs: View serverless function logs under "Deployments"
3. Speed Insights: Monitor Core Web Vitals

## Alternative Deployment Options

### Deploy to Railway

1. Go to [railway.app](https://railway.app)
2. Create a new project from GitHub repo
3. Add environment variable: `ANTHROPIC_API_KEY`
4. Deploy automatically

### Deploy to Fly.io

```bash
# Install flyctl
# macOS
brew install flyctl

# Linux
curl -L https://fly.io/install.sh | sh

# Windows
powershell -Command "iwr https://fly.io/install.ps1 -useb | iex"

# Login
fly auth login

# Launch app
fly launch

# Set environment variable
fly secrets set ANTHROPIC_API_KEY=your-api-key-here

# Deploy
fly deploy
```

### Deploy to Netlify

1. Connect your GitHub repository to Netlify
2. Build settings:
   - Build command: `npm run build`
   - Publish directory: `.next`
3. Add environment variable: `ANTHROPIC_API_KEY`
4. Deploy

## Production Checklist

Before going live, ensure:

- [ ] Environment variables are set correctly
- [ ] Build completes successfully locally (`npm run build`)
- [ ] All example queries work correctly
- [ ] Error handling displays properly
- [ ] Application is responsive on mobile devices
- [ ] API key has sufficient credits
- [ ] Custom domain is configured (if applicable)
- [ ] SSL/HTTPS is working
- [ ] Analytics are configured (optional)

## Monitoring & Maintenance

### API Usage Monitoring

Monitor your Anthropic API usage:
1. Visit [console.anthropic.com](https://console.anthropic.com)
2. Check usage and billing
3. Set up usage alerts if needed

### Performance Monitoring

Use Vercel Analytics to track:
- Page load times
- API response times
- Error rates
- User traffic patterns

### Updating the Application

To deploy updates:

```bash
# Make your changes
git add .
git commit -m "Description of changes"
git push

# Vercel automatically deploys on push to main branch
```

## Troubleshooting

### Deployment Fails

- Check build logs in Vercel dashboard
- Ensure all dependencies are in `package.json`
- Verify TypeScript has no errors: `npm run build`

### API Not Working in Production

- Verify `ANTHROPIC_API_KEY` is set in Vercel environment variables
- Check that the variable name matches exactly
- Redeploy after adding environment variables

### Slow Response Times

- Consider upgrading your Vercel plan for better performance
- Implement caching for common queries
- Use Vercel Edge Functions for lower latency

## Scaling Considerations

As your app grows:

1. **Rate Limiting**: Implement request throttling to prevent abuse
2. **Caching**: Add Redis/Upstash for common queries
3. **Analytics**: Track popular queries to improve UX
4. **Authentication**: Add user accounts for premium features
5. **Database**: Store query history and user preferences

## Support

For deployment issues:
- Vercel: [vercel.com/docs](https://vercel.com/docs)
- Next.js: [nextjs.org/docs](https://nextjs.org/docs)
- Anthropic: [docs.anthropic.com](https://docs.anthropic.com)
