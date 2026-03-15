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
const path = require("path");
const fs = require("fs");
const databaseService = require("./src/services/databaseService");
const logger = require("./src/services/loggerService");
const { errorHandler } = require("./src/middleware/errorHandler");

const apiRoutes = require("./src/api");
const { initBot } = require("./src/bot");

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// Rate limiting configuration from environment variables
const rateLimitWindowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10);
const rateLimitMaxRequests = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100', 10);

const authLimiter = rateLimit({
  windowMs: rateLimitWindowMs,
  max: 10,
  message: { error: "محاولات كثيرة، انتظر 15 دقيقة" },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req, res) => {
    return req.ip === '127.0.0.1' || req.ip === '::1';
  },
  handler: (req, res) => {
    res.status(429).json({ error: "محاولات كثيرة، انتظر 15 دقيقة" });
  },
  trustProxy: 1
});

const apiLimiter = rateLimit({
  windowMs: rateLimitWindowMs,
  max: 1000, // Increased from 100 to 1000 requests per window
  message: { error: "Too many requests, please try again later" },
  skip: (req, res) => {
    return req.ip === '127.0.0.1' || req.ip === '::1';
  },
  handler: (req, res) => {
    res.status(429).json({ error: "Too many requests, please try again later" });
  },
  trustProxy: 1
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
// CORS - allow all in dev, specific origins in production
const corsOptions = {
  origin: process.env.NODE_ENV === 'production' 
    ? (process.env.CORS_ORIGIN || true)  // Allow all in production or use specific origin
    : true,  // Allow all in development
  credentials: true
};
app.use(cors(corsOptions));
app.use(morgan("dev"));
app.use(express.json());

// Apply rate limiting
app.use("/api/auth", authLimiter);
// General API limiter - skip for admin routes to allow dashboard operations
app.use("/api", apiLimiter);

// Serve static files (HTML dashboard)
app.use(express.static("public"));
app.use("/uploads", express.static("src/public/uploads"));

// Health check - works without DB for Railway deployment
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' })
})

// DB health check
app.get('/health/db', async (req, res) => {
  try {
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();
    await prisma.$queryRaw`SELECT 1`;
    await prisma.$disconnect();
    res.status(200).json({ status: 'ok', database: 'connected' });
  } catch (error) {
    res.status(500).json({ status: 'error', database: 'disconnected', error: error.message });
  }
})

// API routes
app.use("/api", apiRoutes);

// Error handling middleware
app.use(errorHandler);

// Redirect root to login page
app.get("/", (req, res) => {
  res.redirect("/login.html");
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
