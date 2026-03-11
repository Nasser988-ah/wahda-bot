require("dotenv").config();

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
const PORT = process.env.PORT || 3000;

// Rate limiting
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // max 10 attempts
  message: { error: "محاولات كثيرة، انتظر 15 دقيقة" },
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute
  message: { error: "Too many requests, please try again later" },
});

// Middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
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
app.use("/api", apiLimiter);

// Serve static files (HTML dashboard)
app.use(express.static("public"));

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' })
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
    logger.info('Starting WhatsApp Bot SaaS application...');

    // Connect to database
    await databaseService.connect();
    logger.info('Database connected successfully');

    app.listen(PORT, '0.0.0.0', () => {
      logger.info(`Server running on port ${PORT}`);
    });

    // Initialize WhatsApp bot
    // Note: Bot is now initialized per-shop via API routes
    // await initBot();
    logger.info('WhatsApp bot initialized');
    
    // Reconnect all previously connected shops
    await reconnectAllShops();
    
    logger.info('Application started successfully');
  } catch (error) {
    logger.error('Failed to start application', error);
    process.exit(1);
  }
}

// Reconnect all shops with existing sessions on startup
async function reconnectAllShops() {
  try {
    const prisma = databaseService.getClient();
    const shops = await prisma.shop.findMany({
      where: { 
        subscriptionStatus: { 
          in: ['TRIAL', 'ACTIVE'] 
        } 
      }
    });
    
    console.log(`🔄 Checking ${shops.length} shops for session restoration...`);
    
    const botManager = require('./src/bot/botManager');
    
    for (const shop of shops) {
      const sessionDir = path.resolve(`./sessions/${shop.id}`);
      
      // Only reconnect if session folder exists and has credentials
      if (fs.existsSync(sessionDir)) {
        const credsPath = path.join(sessionDir, 'creds.json');
        if (fs.existsSync(credsPath)) {
          console.log(`🔄 Restoring session for ${shop.name} (${shop.id})`);
          try {
            await botManager.connectShop(shop.id, (qr) => {
              botManager.setCurrentQr(shop.id, qr);
            });
          } catch (err) {
            console.log(`⚠️ Could not restore ${shop.name}: ${err.message}`);
          }
        } else {
          console.log(`ℹ️ No credentials found for ${shop.name}, skipping`);
        }
      }
    }
    
    console.log(`✅ Shop reconnection complete`);
  } catch (err) {
    console.error('❌ Error reconnecting shops:', err);
  }
}

main();
