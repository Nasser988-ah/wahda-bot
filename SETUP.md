# WhatsApp Bot SaaS - Production Setup Checklist

## Required Configuration ✅

Before deploying to production, ensure all required environment variables are set:

### 1. **Database (PostgreSQL via Supabase)**
- [ ] `DATABASE_URL` - PostgreSQL connection string from Supabase
  - Example: `postgresql://user:password@host:5432/database`
- [ ] `DATABASE_POOL_MIN` - Minimum connection pool size (default: 2)
- [ ] `DATABASE_POOL_MAX` - Maximum connection pool size (default: 10)

### 2. **Security - JWT**
- [ ] `JWT_SECRET` - Strong random string for signing JWT tokens
  - Generate with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
  - **⚠️ NEVER use the same secret as development!**

### 3. **AI Services - Groq**
- [ ] `GROQ_API_KEY` - API key from Groq console
  - Get from: https://console.groq.com/

## Optional Configuration (Enhances Features)

### 4. **Caching - Redis/Upstash**
- [ ] `UPSTASH_REDIS_REST_URL` - Upstash Redis REST endpoint
- [ ] `UPSTASH_REDIS_REST_TOKEN` - Upstash Redis authentication token
- **Note**: If not set, caching features will be disabled (app still works)

### 5. **Logging & Monitoring**
- [ ] `NODE_ENV=production` - Set to production mode
- [ ] `LOG_LEVEL` - Set to "error" or "warn" for production
- [ ] `PORT` - Server port (default: 3000)

### 6. **Rate Limiting**
- [ ] `RATE_LIMIT_WINDOW_MS` - Rate limit window (default: 900000ms = 15min)
- [ ] `RATE_LIMIT_MAX_REQUESTS` - Max requests per window (default: 100)

### 7. **WhatsApp Bot**
- [ ] `BOT_NAME` - Display name for the bot
- [ ] `BOT_SESSION_DIR` - Directory for storing WhatsApp sessions
- [ ] `BOT_MAX_RETRIES` - Max connection attempts
- [ ] `BOT_CONNECT_TIMEOUT` - Connection timeout in ms

### 8. **Security - Password Hashing**
- [ ] `BCRYPT_ROUNDS` - Bcrypt salt rounds (default: 12)

### 9. **CORS**
- [ ] `CORS_ORIGIN` - Allowed origins (default: all origins)

## Deployment Platforms Support

### Railway.app ✅
```bash
# Set all environment variables in Railway dashboard
# PostgreSQL addon auto-creates DATABASE_URL
# App will auto-detect and use Railway's database
```

### Render.com ✅
```bash
# Set environment variables in Render dashboard
# Connect PostgreSQL database in services
# Map DATABASE_URL to your database service
```

### Heroku ✅
```bash
# Set config vars
heroku config:set DATABASE_URL=postgresql://...
heroku config:set JWT_SECRET=your-secret
heroku config:set GROQ_API_KEY=your-key
```

### Docker ✅
```bash
docker run \
  -e DATABASE_URL="postgresql://..." \
  -e JWT_SECRET="..." \
  -e GROQ_API_KEY="..." \
  -e NODE_ENV=production \
  -p 3000:3000 \
  wahda-bot
```

## Security Best Practices

⚠️ **IMPORTANT**:
1. **Never commit secrets** to version control
2. **Use environment variables** for all sensitive data
3. **Rotate secrets regularly** in production
4. **Use HTTPS** in production (enable via platform)
5. **Use strong passwords** for database and JWT secrets
6. **Monitor logs** for suspicious activity

## Startup Validation

The application will automatically:
1. ✅ Validate all required environment variables at startup
2. ✅ Display configuration status
3. ✅ Test database connection
4. ✅ Test Redis connection (if configured)
5. ✅ Restore WhatsApp bot sessions
6. ✅ Start health check endpoints

## Health Endpoints

Once running, check application health:

```bash
# Basic health check (no database required)
curl http://localhost:3000/health

# Database health check
curl http://localhost:3000/health/db

# API health check
curl http://localhost:3000/api/products
```

## Troubleshooting

### Database Connection Failed
- Check `DATABASE_URL` is valid and database is accessible
- Verify network connectivity to database host
- Check database credentials

### Missing Redis
- Redis is optional - app will work without it
- Caching features will be skipped
- Check logs for Redis connection attempts

### Rate Limit Bypass Error
- Ensure `trust proxy` is set (configured in app)
- Check `X-Forwarded-For` header from reverse proxy
- May need to adjust rate limiting in environment

### Bot Sessions Not Restoring
- Check `BOT_SESSION_DIR` path exists
- Verify WhatsApp credentials in sessions folder
- Check file permissions on session directory

## Performance Tuning

For high-traffic deployments:

```env
# Database connection pooling
DATABASE_POOL_MAX=20

# Rate limiting
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=200

# Logging (less logging = better performance)
LOG_LEVEL=error

# Bot retry strategy
BOT_MAX_RETRIES=3
BOT_CONNECT_TIMEOUT=30000
```

## Next Steps

1. ✅ Set all required environment variables
2. ✅ Deploy to your platform
3. ✅ Test health endpoints
4. ✅ Monitor logs for errors
5. ✅ Configure domain & HTTPS
6. ✅ Set up monitoring/alerting

For more details, see the main README.md
