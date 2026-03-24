require("dotenv").config();

// FIX 4: Global error handlers to prevent crashes
process.on('uncaughtException', (err) => {
  console.error('💥 Uncaught Exception:', err.message);
  console.error(err.stack);
  // Don't exit - just log
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't exit - just log
});

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const cookieParser = require("cookie-parser");
const path = require("path");
const fs = require("fs");
const databaseService = require("./src/services/databaseService");
const logger = require("./src/services/loggerService");
const { errorHandler } = require("./src/middleware/errorHandler");
const pageAuth = require("./src/middleware/pageAuth");

const apiRoutes = require("./src/api");
const { initBot } = require("./src/bot");

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// Rate limiting
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'محاولات كثيرة، حاول بعد 15 دقيقة' },
  standardHeaders: true,
  legacyHeaders: false,
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'حاول بعد ساعة' },
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: { error: 'طلبات كثيرة، حاول لاحقاً' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
    },
  },
}));
app.use(cookieParser());
app.use(cors({
  origin: [
    'https://wahda-bot-production-0c88.up.railway.app',
    'http://localhost:3000'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(morgan("dev"));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// Apply rate limiting
app.use('/api/auth/login', loginLimiter);
app.use('/api/auth/register', registerLimiter);
app.use('/api/admin/login', loginLimiter);
app.use('/api/', apiLimiter);

// Block access to sensitive directories
app.use('/sessions', (req, res) => res.status(403).json({ error: 'Forbidden' }));
app.use('/tmp', (req, res) => res.status(403).json({ error: 'Forbidden' }));
app.use('/.env', (req, res) => res.status(403).json({ error: 'Forbidden' }));
app.use('/.git', (req, res) => res.status(403).json({ error: 'Forbidden' }));

// Protect dashboard pages - must be BEFORE static serving
const protectedPages = [
  '/dashboard.html',
  '/products.html',
  '/qr.html',
  '/settings.html'
];
protectedPages.forEach(page => {
  app.get(page, pageAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', page));
  });
});

// Serve landing page assets at /landing
app.use('/landing', express.static(path.join(__dirname, 'public', 'landing'), {
  dotfiles: 'deny',
  maxAge: '1h'
}));

// Serve static files (HTML dashboard)
app.use(express.static("public", {
  dotfiles: 'deny',
  index: false
}));
app.use("/uploads", express.static("src/public/uploads", {
  dotfiles: 'deny',
  index: false
}));

// Health check - works without DB for Railway deployment
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' })
})

// DB health check
app.get('/health/db', async (req, res) => {
  try {
    if (!databaseService.isConnected) {
      return res.status(503).json({ status: 'error', database: 'disconnected' });
    }
    const prisma = databaseService.getClient();
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({ status: 'ok', database: 'connected' });
  } catch (error) {
    res.status(500).json({ status: 'error', database: 'disconnected' });
  }
})

// API routes
app.use("/api", apiRoutes);

// Error handling middleware
app.use(errorHandler);

// Serve landing page at root
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "landing", "index.html"));
});

// Store page route
app.get("/store/:shopId", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "store.html"));
});

// 404 handlers
app.use('/api/*', (req, res) => {
  res.status(404).json({ error: 'المسار غير موجود' });
});

app.use((req, res) => {
  res.status(404).send(`
    <!DOCTYPE html>
    <html lang="ar" dir="rtl">
    <head>
      <meta charset="UTF-8">
      <title>404</title>
      <style>
        body {
          font-family: Cairo, sans-serif;
          display:flex;align-items:center;
          justify-content:center;height:100vh;
          margin:0;background:#0f0f13;color:#fff;
          text-align:center;
        }
        h1 { font-size:80px;margin:0;color:#f5c842; }
        p { color:#8a8a9a;font-size:18px; }
        a { color:#f5c842;text-decoration:none;font-weight:bold; }
      </style>
    </head>
    <body>
      <div>
        <h1>404</h1>
        <p>الصفحة غير موجودة</p>
        <a href="/">العودة للرئيسية</a>
      </div>
    </body>
    </html>
  `);
});

// Graceful shutdown
process.on("SIGINT", async () => {
  logger.info("Graceful shutdown initiated (SIGINT)");
  await databaseService.disconnect();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  logger.info("Graceful shutdown initiated (SIGTERM)");
  await databaseService.disconnect();
  process.exit(0);
});

// Start server
async function main() {
  try {
    // Load and log configuration (warnings only, no exit)
    const { logConfiguration, getConfigStatus } = require("./src/config/env");
    logConfiguration();
    const configStatus = getConfigStatus();
    
    if (!configStatus.isValid) {
      logger.warn('⚠️  Some required environment variables are missing');
      logger.warn('   The application will start, but some features may not work');
      if (configStatus.missing.length > 0) {
        logger.warn('   Missing: ' + configStatus.missing.join(', '));
      }
    }
    
    logger.info('Starting WhatsApp Bot SaaS application...');

    // Start server immediately (don't wait for reconnect)
    app.listen(PORT, '0.0.0.0', () => {
      logger.info(`Server running on port ${PORT}`);
    });

    // Connect to database
    try {
      await databaseService.connect();
      if (databaseService.isConnected) {
        logger.info('Database connected successfully');
      } else {
        logger.warn('Database not configured - features requiring database will be unavailable');
      }
    } catch (dbError) {
      logger.warn('Database connection failed:', dbError.message);
    }

    // Initialize WhatsApp bot
    // Note: Bot is now initialized per-shop via API routes
    // await initBot();
    logger.info('WhatsApp bot initialized');
    
    // Reconnect all previously connected shops from database (non-blocking)
    if (databaseService.isConnected) {
      restoreAllSessions().catch(err => {
        logger.error('Session restoration failed:', err.message);
      });
    } else {
      logger.warn('Skipping session restoration - database not connected');
    }
    
    logger.info('Application started successfully');
  } catch (error) {
    logger.error('Failed to start application', error);
    process.exit(1);
  }
}

// Restore all WhatsApp sessions from database on startup
async function restoreAllSessions() {
  try {
    const prisma = databaseService.getClient();
    if (!prisma) {
      console.warn('⚠️ Cannot restore sessions - database not configured');
      return;
    }

    // Find all shops that have saved sessions in database
    const sessions = await prisma.whatsAppSession.findMany({
      include: { shop: true }
    });

    console.log(`🔄 Restoring ${sessions.length} WhatsApp sessions from database...`);

    const botManager = require('./src/bot/botManager');

    for (const session of sessions) {
      try {
        console.log(`🔄 Restoring ${session.shop.name} (${session.shopId})...`);
        await botManager.connectShop(session.shopId, (qr) => {
          botManager.setCurrentQr(session.shopId, qr);
        });
        // Small delay between connections to avoid overwhelming the system
        await new Promise(r => setTimeout(r, 2000));
      } catch (err) {
        console.error(`❌ Failed to restore ${session.shop.name}:`, err.message);
      }
    }

    console.log('✅ All sessions restored!');
  } catch (err) {
    console.error('❌ Error restoring sessions:', err);
  }
}

main();
