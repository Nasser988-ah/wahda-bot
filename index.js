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

const publicChatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'طلبات كثيرة، حاول بعد دقيقة' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply rate limiting
app.use('/api/auth/login', loginLimiter);
app.use('/api/auth/register', registerLimiter);
app.use('/api/admin/login', loginLimiter);
app.use('/api/public', publicChatLimiter);
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
  '/settings.html',
  '/custom-dashboard.html',
  '/custom-bot-config.html',
  '/custom-menus.html',
  '/custom-ai-settings.html'
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
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
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
    
    // One-time migration: rename nasser shop to Zaki Bot + update AI config
    if (databaseService.isConnected) {
      migrateNasserShop().catch(err => {
        logger.warn('Shop migration skipped:', err.message);
      });
    }

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

// Startup migrations: ensure all shops have admin records + specific fixes
async function migrateNasserShop() {
  try {
    const prisma = databaseService.getClient();
    if (!prisma) return;
    const bcrypt = require('bcryptjs');

    // ── Create VIP shops if they don't exist ──
    const vipShops = [
      { phone: '201128511900', name: 'Zaki Bot', ownerName: 'Zaki Bot', password: 'nasser' },
      { phone: '201101222922', name: 'Archers for Shooting Sports', ownerName: 'Archers', password: 'p28rm6ejA1!' },
    ];
    for (const vip of vipShops) {
      const hashedPw = await bcrypt.hash(vip.password, 10);
      const exists = await prisma.shop.findUnique({ where: { phone: vip.phone } });
      if (!exists) {
        await prisma.shop.create({
          data: {
            name: vip.name,
            ownerName: vip.ownerName,
            phone: vip.phone,
            whatsappNumber: vip.phone,
            shopType: 'custom',
            subscriptionStatus: 'ACTIVE',
            subscriptionEnd: new Date('2030-12-31'),
            password: hashedPw,
          }
        });
        console.log(`✅ Created VIP shop: ${vip.name} (${vip.phone})`);
      } else {
        // Ensure VIP shop is properly configured
        await prisma.shop.update({
          where: { phone: vip.phone },
          data: {
            name: vip.name,
            ownerName: vip.ownerName,
            shopType: 'custom',
            subscriptionStatus: 'ACTIVE',
            subscriptionEnd: new Date('2030-12-31'),
          }
        });
        console.log(`✅ Updated VIP shop: ${vip.name} (${vip.phone})`);
      }
      // Ensure admin record with correct password
      const email = `${vip.phone}@wahdabot.com`;
      const admin = await prisma.admin.findFirst({ where: { email } });
      if (!admin) {
        await prisma.admin.create({ data: { email, password: hashedPw } });
        console.log(`✅ Created admin for ${vip.name}`);
      } else {
        await prisma.admin.update({ where: { id: admin.id }, data: { password: hashedPw } });
        console.log(`✅ Updated admin password for ${vip.name}`);
      }
    }

    // ── Ensure admin records exist for all shops ──
    const shops = await prisma.shop.findMany({ select: { id: true, phone: true, name: true, ownerName: true } });
    for (const s of shops) {
      const email = `${s.phone}@wahdabot.com`;
      const existing = await prisma.admin.findFirst({ where: { email } });
      if (!existing) {
        const hashedPassword = await bcrypt.hash(s.phone, 10);
        await prisma.admin.create({ data: { email, password: hashedPassword } });
        console.log(`✅ Created admin record for ${s.name} (${s.phone}) - password is phone number`);
      }
    }

    // ── Zaki Bot specific fixes ──
    const zakiShop = shops.find(s => s.phone === '201128511900');
    if (zakiShop) {
      // Rename from nasser
      if (zakiShop.name === 'nasser' || zakiShop.ownerName === 'nasser') {
        await prisma.shop.update({
          where: { id: zakiShop.id },
          data: { name: 'Zaki Bot', ownerName: 'Zaki Bot' }
        });
        try {
          const botManager = require('./src/bot/botManager');
          botManager.invalidateShopCache(zakiShop.id);
        } catch (e) { /* ignore */ }
        console.log('✅ Renamed shop from nasser to Zaki Bot');
      }

      // Fix AI prompt name
      const config = await prisma.botConfig.findUnique({ where: { shopId: zakiShop.id } });
      if (config) {
        const updates = {};
        if (config.aiSystemPrompt && config.aiSystemPrompt.includes('زكي')) {
          updates.aiSystemPrompt = config.aiSystemPrompt.replace(/زكي/g, 'ذكي');
        }
        if (config.aiMaxTokens > 400) {
          updates.aiMaxTokens = 400;
        }
        if (Object.keys(updates).length > 0) {
          await prisma.botConfig.update({ where: { shopId: zakiShop.id }, data: updates });
          console.log('✅ Updated Zaki Bot AI config:', Object.keys(updates).join(', '));
        }
      }
    }
    // ── Archers for Shooting Sports setup ──
    const archersShop = shops.find(s => s.phone === '201101222922');
    if (archersShop) {
      console.log('⚙️ Setting up Archers BotConfig + menus...');
      const NOTIFY = '201128511900';

      const archersPrompt = `[الهوية]
أنت المساعد الذكي الرسمي لـ *Archers for Shooting Sports* — أكاديمية رياضات الرماية.
أنت مستشار رياضي محترف، شغوف بالرياضة وعارف كل التفاصيل عن البرامج التدريبية.
صوتك: حماسي، مقنع، محترف، ودود.

[قاعدة اللغة]
- ردودك دائماً بالعربية فقط. لا تكتب بأي لغة أخرى.
- الاستثناء: "Archers for Shooting Sports" يُكتب كما هو.

[أسلوب الرد]
- ردود قصيرة (٣-٦ أسطر). إيموجي باعتدال.
- كن حماسي ومقنع — الهدف إقناع العميل يحجز.
- لو بيتكلم عامية رد عامية، لو فصحى رد فصحى.

[مهمتك — الإقناع]
الرماية مش مجرد هواية — رياضة أولمبية بتحسن التركيز والثقة والهدوء تحت الضغط. مناسبة لكل الأعمار. بيئة آمنة ١٠٠٪ مع مدربين محترفين.

[البرامج]
• برنامج المبتدئين — أساسيات الرماية والأمان
• برنامج المتقدمين — تقنيات متقدمة وإعداد للبطولات
• برنامج الأطفال والناشئين — من ١٠ سنين، بيئة آمنة
• برنامج الشركات — Team Building وتجارب جماعية
• تجربة مجانية / زيارة تعريفية — متاحة للجميع

[الرياضات]
رماية بالمسدس، بالبندقية، بالقوس والسهم، الرماية الأولمبية

[الحجز]
١. يختار البرنامج ٢. يدفع ١٠٪ حجز ٣. الحسابات تأكد ٤. الإداري يتابع ٥. يبدأ التدريب

[التواصل]
الإدارة: 01128511900 | واتساب: 01128511900

[سيناريوهات]
عايز يجرب → اعرض التجربة المجانية واطلب اسمه ورقمه
سأل عن السعر → الأسعار حسب البرنامج، الحجز ١٠٪، وجّه للإدارة
متردد → ركز على الفوائد الصحية والنفسية واعرض التجربة

[ممنوعات]
لا تكشف أسرار تقنية. لا أسعار محددة. لا ترد بغير العربية. ركز على الجانب الرياضي والأمان.`;

      const configData = {
        welcomeMessage: 'أهلاً وسهلاً في *Archers for Shooting Sports*! 🎯\n\nأنا مساعدك الذكي، جاهز أساعدك تعرف كل حاجة عن رياضات الرماية والبرامج التدريبية.\n\nاختر من القائمة أو اكتب سؤالك مباشرة 👇',
        unknownMessage: 'ممكن توضح أكتر؟ 😊 أنا جاهز أساعدك في أي حاجة عن برامجنا التدريبية.\n\nاكتب *قائمة* لو عايز تشوف الخيارات 📋',
        orderConfirmMessage: 'شكراً لاهتمامك! 🎯🎉\n\nتم تسجيل بياناتك بنجاح ✅\nفريقنا هيتواصل معاك في أقرب وقت لتأكيد الحجز.\n\nللاستفسار: 01128511900 📱',
        aiSystemPrompt: archersPrompt,
        aiProvider: 'groq',
        aiModel: 'llama-3.3-70b-versatile',
        aiTemperature: 0.7,
        aiMaxTokens: 400,
        formalityLevel: 2,
      };

      // Upsert BotConfig (update if exists, create if not)
      const existingConfig = await prisma.botConfig.findUnique({ where: { shopId: archersShop.id } });
      if (existingConfig) {
        await prisma.botConfig.update({ where: { shopId: archersShop.id }, data: configData });
        console.log('✅ Archers BotConfig updated');
      } else {
        await prisma.botConfig.create({ data: { shopId: archersShop.id, ...configData } });
        console.log('✅ Archers BotConfig created');
      }

      // Delete old menus and recreate
      const oldMenus = await prisma.customMenu.findMany({ where: { shopId: archersShop.id }, select: { id: true } });
      if (oldMenus.length > 0) {
        const oldIds = oldMenus.map(m => m.id);
        await prisma.customMenuItem.deleteMany({ where: { menuId: { in: oldIds } } });
        await prisma.customMenu.deleteMany({ where: { id: { in: oldIds } } });
        console.log(`🗑️ Deleted ${oldMenus.length} old Archers menus`);
      }

      // Create menus
      const mainMenu = await prisma.customMenu.create({
        data: { shopId: archersShop.id, name: 'القائمة الرئيسية', order: 0, isActive: true }
      });
      const programsMenu = await prisma.customMenu.create({
        data: { shopId: archersShop.id, name: 'البرامج التدريبية', order: 1, isActive: true }
      });
      const sportsMenu = await prisma.customMenu.create({
        data: { shopId: archersShop.id, name: 'الرياضات المتاحة', order: 2, isActive: true }
      });

      await prisma.customMenuItem.createMany({ data: [
        { menuId: mainMenu.id, number: 1, label: '🎯 البرامج التدريبية', action: 'go_to_menu', actionValue: programsMenu.id },
        { menuId: mainMenu.id, number: 2, label: '🏹 الرياضات المتاحة', action: 'go_to_menu', actionValue: sportsMenu.id },
        { menuId: mainMenu.id, number: 3, label: '🆓 احجز تجربة / زيارة', action: 'confirm_order', actionValue: NOTIFY },
        { menuId: mainMenu.id, number: 4, label: '💰 الأسعار والباقات', action: 'ai_response' },
        { menuId: mainMenu.id, number: 5, label: '📱 تواصل مع الإدارة', action: 'custom_message', actionValue: 'للتواصل مع الإدارة:\n📱 واتساب: 01128511900\n📞 اتصال: 01128511900\n\nفريقنا جاهز يساعدك! 🤝' },
      ]});

      await prisma.customMenuItem.createMany({ data: [
        { menuId: programsMenu.id, number: 1, label: '🎯 برنامج المبتدئين', action: 'ai_response' },
        { menuId: programsMenu.id, number: 2, label: '🏆 برنامج المتقدمين', action: 'ai_response' },
        { menuId: programsMenu.id, number: 3, label: '👧 برنامج الأطفال والناشئين', action: 'ai_response' },
        { menuId: programsMenu.id, number: 4, label: '🏢 برنامج الشركات والمجموعات', action: 'ai_response' },
        { menuId: programsMenu.id, number: 5, label: '📝 احجز الآن', action: 'confirm_order', actionValue: NOTIFY },
        { menuId: programsMenu.id, number: 6, label: '🔙 العودة للقائمة الرئيسية', action: 'go_to_menu', actionValue: mainMenu.id },
      ]});

      await prisma.customMenuItem.createMany({ data: [
        { menuId: sportsMenu.id, number: 1, label: '🔫 رماية بالمسدس', action: 'ai_response' },
        { menuId: sportsMenu.id, number: 2, label: '🎯 رماية بالبندقية', action: 'ai_response' },
        { menuId: sportsMenu.id, number: 3, label: '🏹 رماية بالقوس والسهم', action: 'ai_response' },
        { menuId: sportsMenu.id, number: 4, label: '🥇 الرماية الأولمبية', action: 'ai_response' },
        { menuId: sportsMenu.id, number: 5, label: '📝 احجز تجربة', action: 'confirm_order', actionValue: NOTIFY },
        { menuId: sportsMenu.id, number: 6, label: '🔙 العودة للقائمة الرئيسية', action: 'go_to_menu', actionValue: mainMenu.id },
      ]});

      await prisma.botConfig.update({ where: { shopId: archersShop.id }, data: { mainMenuId: mainMenu.id } });
      // Verify items were created correctly
      const verifyItems = await prisma.customMenuItem.findMany({
        where: { menuId: { in: [mainMenu.id, programsMenu.id, sportsMenu.id] } },
        select: { number: true, label: true, action: true, actionValue: true },
        orderBy: { number: 'asc' },
      });
      const confirmItems = verifyItems.filter(i => i.action === 'confirm_order');
      console.log(`✅ Archers menus created: ${verifyItems.length} items total, ${confirmItems.length} confirm_order items`);
      confirmItems.forEach(i => console.log(`   📝 confirm_order: "${i.label}" → notify ${i.actionValue}`));
    }
  } catch (err) {
    console.error('⚠️ Migration error:', err.message);
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
