# Railway Deployment Setup Guide

## Problem
Your app is now set to start even without environment variables configured, but it will show warnings. To make it work fully on Railway, you need to configure the required environment variables.

## Step 1: Add PostgreSQL Database to Railway

1. Go to your Railway project dashboard
2. Click "**+ Add a service**" button
3. Select "**PostgreSQL**"
4. Railway will automatically create `DATABASE_URL` environment variable for you ✅

## Step 2: Configure Required Environment Variables

In your Railway project, go to **Variables** tab and add:

### Required Variables

1. **JWT_SECRET** (required for authentication)
   ```
   JWT_SECRET = [generate a random 32+ character string]
   ```
   Generate using an online tool or:
   ```bash
   # On your computer, run:
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
   Then copy the output and paste as JWT_SECRET

2. **GROQ_API_KEY** (required for AI responses)
   ```
   GROQ_API_KEY = gsk_[your actual Groq API key]
   ```
   - Go to https://console.groq.com
   - Create/copy your API key
   - Paste it in Railway

3. **NODE_ENV** (recommended)
   ```
   NODE_ENV = production
   ```

### Optional Variables

4. **UPSTASH_REDIS_REST_URL** (for caching performance)
   ```
   UPSTASH_REDIS_REST_URL = https://[your-redis].upstash.io
   ```

5. **UPSTASH_REDIS_REST_TOKEN** (for caching)
   ```
   UPSTASH_REDIS_REST_TOKEN = [your-redis-token]
   ```

## Step 3: Check Your Configuration

1. In Railway, click your WhatsApp Bot service
2. Go to the **Logs** tab
3. The app should now start with messages like:

```
✅ All required environment variables are set
📋 Application Configuration:
  Environment: production
  Port: 3000
  Log Level: info
  Database: ✅ Connected
  Redis: ✅ Configured
  Groq AI: ✅ Configured
✅ Database connected successfully
[timestamp] INFO: Starting WhatsApp Bot SaaS application...
```

## Step 4: Verify Deployment

Check if your app is running:
- Visit: `https://your-railway-domain.up.railway.app/health`
- Expected response: `{"status":"ok"}`

Check database connectivity:
- Visit: `https://your-railway-domain.up.railway.app/health/db`
- Expected response: `{"status":"ok","database":"connected"}`

## What Each Variable Does

| Variable | Purpose | Required | Example |
|----------|---------|----------|---------|
| `DATABASE_URL` | PostgreSQL connection (auto-set by Railway) | ✅ Yes | Already configured |
| `JWT_SECRET` | Signs authentication tokens |✅ Yes | Random 32+ char string |
| `GROQ_API_KEY` | AI responses for chat | ✅ Yes | `gsk_...` |
| `UPSTASH_REDIS_REST_URL` | Redis cache endpoint | ❌ Optional | `https://...upstash.io` |
| `UPSTASH_REDIS_REST_TOKEN` | Redis authentication | ❌ Optional | `ABCxyz...` |
| `NODE_ENV` | Environment mode | ❌ (defaults to production) | `production` |

## Troubleshooting Railway Deployment

### Error: "DATABASE_URL is not set"
- Solution: Add PostgreSQL addon to Railway
- Go to "+ Add Service" → PostgreSQL
- Railway will auto-create `DATABASE_URL`

### Error: "Missing GROQ_API_KEY"
- Solution: Set it in Railway Variables
- Get key from https://console.groq.com
- Paste in Railway dashboard

### Error: "CORS disabled" / "Cannot register"
- Solution: This is expected until DATABASE_URL is set
- The app needs database to store user accounts
- Add PostgreSQL addon first

### Logs show warnings about missing variables
- This is normal during setup
- Add the missing variables one at a time
- Restart the service after each variable addition

### App keeps crashing/restarting
- Check Railway logs for specific errors
- Verify DATABASE_URL is properly set
- Ensure PostgreSQL addon is running and healthy
- Check database connectivity in `/health/db` endpoint

## Deploying Code Changes

After making code changes:
1. Commit to GitHub: `git push origin main`
2. Railway auto-deploys on push (if connected)
3. Watch the Logs tab for deployment progress
4. Check `/health` endpoint when deployment completes

## Next Steps After Setup

1. ✅ Configure all required environment variables
2. ✅ Verify `/health` endpoint returns success
3. ✅ Test authentication: POST `/api/auth/register`
4. ✅ Connect WhatsApp bot: Visit `/` → Dashboard
5. ✅ Monitor logs for issues

## Important Security Notes

🔒 **Never share your Railway environment variables** (they contain secrets!)

If variables are compromised:
1. Regenerate JWT_SECRET
2. Regenerate GROQ_API_KEY
3. Regenerate UPSTASH_REDIS_REST_TOKEN
4. Update them in Railway dashboard

## Need More Help?

- Check `SETUP.md` in the project root for detailed configuration info
- Visit Railway docs: https://docs.railway.app
- Check application logs for specific error messages
