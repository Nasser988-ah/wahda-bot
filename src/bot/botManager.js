const {
  default: makeWASocket,
  DisconnectReason,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const databaseService = require("../services/databaseService");
const redis = require("../db/redis");
const { HfInference } = require("@huggingface/inference");
const Groq = require("groq-sdk");
const { useDBAuthState } = require("../services/dbAuthState");

const HF_TOKEN = process.env.HUGGINGFACE_TOKEN;
const hf = HF_TOKEN ? new HfInference(HF_TOKEN) : null;

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const groq = GROQ_API_KEY ? new Groq({ apiKey: GROQ_API_KEY }) : null;

// Normalize Arabic numerals to English numbers
function normalizeNumbers(text) {
  if (!text) return '';
  const arabicNumerals = {
    '٠': '0', '١': '1', '٢': '2', '٣': '3',
    '٤': '4', '٥': '5', '٦': '6', '٧': '7',
    '٨': '8', '٩': '9'
  };
  return text.replace(/[٠-٩]/g, d => arabicNumerals[d] || d);
}

// Normalize Arabic text for comparison
function normalizeArabic(text) {
  return text
    .replace(/أ|إ|آ/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/ئ|ء/g, 'ء')
    .replace(/ؤ/g, 'و')
    .replace(/ّ|َ|ُ|ِ|ْ|ً|ٌ|ٍ/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

// Strip common Egyptian request prefixes for better product matching
function stripRequestPrefixes(text) {
  const prefixes = /^(عايز|عاوز|هات|هاتلي|ابعتلي|ابعت|جيبلي|جيب|ضيف|اضيف|اضافة|ممكن|محتاج|نفسي في|بدي|اريد|أريد)\s+/i;
  let cleaned = text.replace(prefixes, '').trim();
  // Also strip "ال" article if it starts with it and the remaining text is long enough
  return cleaned;
}

// Find best matching product
function findBestMatch(text, products) {
  const normalizedInput = normalizeArabic(text);
  // Also try with stripped prefixes for better matching
  const strippedInput = normalizeArabic(stripRequestPrefixes(text));
  const candidates = [];

  products.filter(p => p.isAvailable).forEach(p => {
    const normalizedName = normalizeArabic(p.name);

    // Exact match
    if (normalizedInput === normalizedName) {
      candidates.push({ product: p, score: 1.0 });
      return;
    }

    // Also check stripped version for exact match
    if (strippedInput !== normalizedInput && strippedInput === normalizedName) {
      candidates.push({ product: p, score: 0.98 });
      return;
    }

    // Input is contained in product name
    if (normalizedName.includes(normalizedInput) || normalizedName.includes(strippedInput)) {
      candidates.push({ product: p, score: 0.95 });
      return;
    }

    // Product name is contained in input
    if (normalizedInput.includes(normalizedName) || strippedInput.includes(normalizedName)) {
      candidates.push({ product: p, score: 0.9 });
      return;
    }

    // Word-by-word matching (use stripped version for better matching)
    const bestInput = strippedInput !== normalizedInput ? strippedInput : normalizedInput;
    const inputWords = bestInput.split(' ').filter(w => w.length > 1);
    const nameWords = normalizedName.split(' ').filter(w => w.length > 1);

    let wordMatches = 0;
    inputWords.forEach(inputWord => {
      if (nameWords.some(nameWord => nameWord.includes(inputWord) || inputWord.includes(nameWord))) {
        wordMatches++;
      }
    });

    const wordScore = inputWords.length > 0 ? wordMatches / inputWords.length : 0;

    // Character-level similarity
    const longer = normalizedInput.length > normalizedName.length
      ? normalizedInput : normalizedName;
    const shorter = normalizedInput.length > normalizedName.length
      ? normalizedName : normalizedInput;

    let charMatches = 0;
    const shorterChars = shorter.split('');
    const longerChars = longer.split('');

    for (let i = 0; i < shorterChars.length; i++) {
      if (longerChars.includes(shorterChars[i])) charMatches++;
    }
    const charScore = shorter.length > 0 ? charMatches / longer.length : 0;

    // Combined score (weighted)
    const finalScore = (wordScore * 0.6) + (charScore * 0.4);

    if (finalScore >= 0.5) {
      candidates.push({ product: p, score: finalScore });
    }
  });

  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

const prisma = databaseService.getClient();

// ===================== Working Hours Helpers =====================
const DAY_NAMES_EN = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
const DAY_NAMES_AR = { saturday: 'السبت', sunday: 'الأحد', monday: 'الاثنين', tuesday: 'الثلاثاء', wednesday: 'الأربعاء', thursday: 'الخميس', friday: 'الجمعة' };

function getEgyptNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Africa/Cairo' }));
}

function isShopOpen(shop) {
  if (shop.isAlwaysOpen === true || shop.isAlwaysOpen === undefined || shop.isAlwaysOpen === null) return true;
  if (!shop.workingHours) return true;

  let hours;
  try { hours = typeof shop.workingHours === 'string' ? JSON.parse(shop.workingHours) : shop.workingHours; } catch { return true; }

  const now = getEgyptNow();
  const todayKey = DAY_NAMES_EN[now.getDay()];
  const today = hours[todayKey];
  if (!today || !today.active) return false;

  const currentMin = now.getHours() * 60 + now.getMinutes();
  const [oh, om] = today.open.split(':').map(Number);
  const [ch, cm] = today.close.split(':').map(Number);
  const openMin = oh * 60 + om;
  const closeMin = ch * 60 + cm;

  if (closeMin > openMin) {
    return currentMin >= openMin && currentMin < closeMin;
  } else {
    // Midnight crossing (e.g. 20:00 - 02:00)
    return currentMin >= openMin || currentMin < closeMin;
  }
}

function getNextOpenTime(shop) {
  if (!shop.workingHours) return '';
  let hours;
  try { hours = typeof shop.workingHours === 'string' ? JSON.parse(shop.workingHours) : shop.workingHours; } catch { return ''; }

  const now = getEgyptNow();
  const todayIdx = now.getDay();
  const currentMin = now.getHours() * 60 + now.getMinutes();

  // Check the next 7 days (including today's remaining time)
  for (let offset = 0; offset < 7; offset++) {
    const dayIdx = (todayIdx + offset) % 7;
    const dayKey = DAY_NAMES_EN[dayIdx];
    const day = hours[dayKey];
    if (!day || !day.active) continue;

    const [oh, om] = day.open.split(':').map(Number);
    const openMin = oh * 60 + om;

    if (offset === 0 && currentMin < openMin) {
      const h = oh > 12 ? oh - 12 : oh || 12;
      const ampm = oh >= 12 ? 'مساءً' : 'صباحاً';
      return `اليوم الساعة ${h}:${String(om).padStart(2,'0')} ${ampm}`;
    }
    if (offset > 0) {
      const h = oh > 12 ? oh - 12 : oh || 12;
      const ampm = oh >= 12 ? 'مساءً' : 'صباحاً';
      const label = offset === 1 ? 'غداً' : `يوم ${DAY_NAMES_AR[dayKey]}`;
      return `${label} الساعة ${h}:${String(om).padStart(2,'0')} ${ampm}`;
    }
  }
  return '';
}

function getWorkingHoursSchedule(shop) {
  if (!shop.workingHours) return '';
  let hours;
  try { hours = typeof shop.workingHours === 'string' ? JSON.parse(shop.workingHours) : shop.workingHours; } catch { return ''; }

  const lines = [];
  const orderedDays = ['saturday','sunday','monday','tuesday','wednesday','thursday','friday'];
  for (const key of orderedDays) {
    const day = hours[key];
    const name = DAY_NAMES_AR[key];
    if (day && day.active) {
      lines.push(`${name}: ${day.open} - ${day.close}`);
    } else {
      lines.push(`${name}: مغلق`);
    }
  }
  return lines.join('\n');
}

// FIX 1: In-memory shop cache with 5-minute TTL
const shopCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getShopCached(shopId) {
  const cached = shopCache.get(shopId);
  if (cached && Date.now() - cached.time < CACHE_TTL) {
    console.log(`📦 Cache HIT for shop ${shopId} (age: ${Math.round((Date.now() - cached.time)/1000)}s)`);
    return cached.data;
  }
  
  console.log(`🔄 Cache MISS for shop ${shopId} - fetching from DB...`);
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    include: { products: { where: { isAvailable: true } } }
  });
  
  if (shop) {
    shopCache.set(shopId, { data: shop, time: Date.now() });
    console.log(`✅ Cached shop ${shopId} with ${shop.products?.length || 0} products`);
  }
  return shop;
}

// FIX 2: Message processing queue per shop to limit concurrency
const processingQueue = new Map();

async function queueMessage(shopId, handler) {
  if (!processingQueue.has(shopId)) {
    processingQueue.set(shopId, Promise.resolve());
  }
  
  const queue = processingQueue.get(shopId);
  const next = queue.then(handler).catch(console.error);
  processingQueue.set(shopId, next);
  return next;
}

// FIX 3: Batch Redis calls for customer data
async function getCustomerData(shopId, customerPhone) {
  const cartKey = `cart:${shopId}:${customerPhone}`;
  const stateKey = `order_state:${shopId}:${customerPhone}`;
  const firstTimeKey = `firsttime:${shopId}:${customerPhone}`;
  const pendingKey = `pending:${shopId}:${customerPhone}`;
  const msgCountKey = `msgcount:${shopId}:${customerPhone}`;
  const cancelConfirmKey = `cancel_confirm:${shopId}:${customerPhone}`;
  
  const [cart, state, firstTime, pending, msgCount, cancelConfirm] = await Promise.all([
    redis.get(cartKey),
    redis.get(stateKey),
    redis.get(firstTimeKey),
    redis.get(pendingKey),
    redis.get(msgCountKey),
    redis.get(cancelConfirmKey)
  ]);
  
  return {
    cart: cart ? (typeof cart === 'string' ? JSON.parse(cart) : cart) : [],
    state,
    isFirstTime: !firstTime,
    pending: pending ? (typeof pending === 'string' ? JSON.parse(pending) : pending) : null,
    msgCount: parseInt(msgCount) || 0,
    cancelConfirm
  };
}

// FIX 5: Limit AI calls per customer (max 5 per hour)
async function shouldUseAI(shopId, customerPhone) {
  const aiCallKey = `aicalls:${shopId}:${customerPhone}`;
  const calls = parseInt(await redis.get(aiCallKey) || '0');
  
  if (calls >= 5) {
    return false;
  }
  
  await redis.set(aiCallKey, calls + 1, { ex: 3600 });
  return true;
}

// FIX 6: Memory cleanup every hour
setInterval(() => {
  const now = Date.now();
  let cleared = 0;
  
  // Clear expired shop cache entries
  for (const [key, value] of shopCache.entries()) {
    if (now - value.time > CACHE_TTL) {
      shopCache.delete(key);
      cleared++;
    }
  }
  
  // Clear old message queues (keep only active ones)
  for (const [key, queue] of processingQueue.entries()) {
    // Check if queue is idle (will be a resolved promise if idle)
    // We'll clear queues that haven't been used in 10 minutes
    const lastActivity = processingQueue.get(`_last:${key}`);
    if (lastActivity && now - lastActivity > 10 * 60 * 1000) {
      processingQueue.delete(key);
      processingQueue.delete(`_last:${key}`);
      cleared++;
    }
  }
  
  console.log(`🧹 Memory cleanup: cleared ${cleared} items`);
}, 60 * 60 * 1000); // Every hour

class BotManager {
  constructor() {
    this.connections = new Map();
    this.qrCallbacks = new Map();
    this.connectionStates = new Map();
    this.qrReceived = new Map();
    this.currentQrs = new Map();
    this.reconnectAttempts = new Map();
    this.processingQueue = new Map(); // FIX 2: Queue per shop
  }

  // BUG 2 FIX: Invalidate shop cache when products change
  invalidateShopCache(shopId) {
    const hadCache = shopCache.has(shopId);
    shopCache.delete(shopId);
    console.log(`🔄 Cache cleared for shop ${shopId} (had cache: ${hadCache}, cache size: ${shopCache.size})`);
    
  }

  async connectShop(shopId, qrCallback) {
    try {
      // Check if already connected
      if (this.connectionStates.get(shopId) === 'connected') {
        console.log(`✅ Shop ${shopId} already connected`);
        return this.connections.get(shopId);
      }

      // Check if connection in progress
      if (this.connectionStates.get(shopId) === 'connecting') {
        console.log(`⏳ Connection already in progress for ${shopId}`);
        return this.connections.get(shopId);
      }

      // FIX 1: Use cached shop data instead of fetching from DB every message
      const shop = await getShopCached(shopId);

      if (!shop) throw new Error("Shop not found");

      // Mark as connecting
      this.connectionStates.set(shopId, 'connecting');
      this.qrReceived.set(shopId, false);
      
      // Initialize auth state from database
      const { state, saveCreds, deleteSession } = await useDBAuthState(shopId);

      // Create socket with proper configuration for QR generation
      const sock = makeWASocket({
        auth: state,
        logger: pino({ level: "silent" }),
        printQRInTerminal: false,
        keepAliveIntervalMs: 30000,
        connectTimeoutMs: 120000, // Increased to 2 minutes
        qrTimeout: 60000, // Increased to 1 minute
        defaultQueryTimeoutMs: 20000, // Add query timeout
        retryRequestDelayMs: 500, // Add retry delay
        maxMsgRetryCount: 3, // Limit retry attempts
        shouldIgnoreJid: () => false,
        shouldSyncHistoryMessage: () => false,
      });

      // Store connection
      this.connections.set(shopId, sock);
      this.qrCallbacks.set(shopId, qrCallback);

      // Handle credentials update with logging
      sock.ev.on('creds.update', () => {
        saveCreds();
        console.log(`💾 Session credentials saved for ${shop.name} (${shopId})`);
      });

      // Handle connection updates with smart reconnect
      sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
        
        // New QR generated
        if (qr) {
          console.log(`📱 QR generated for ${shop.name}`);
          this.connectionStates.set(shopId, 'qr');
          this.qrReceived.set(shopId, true);
          this.setCurrentQr(shopId, qr);
          if (qrCallback) qrCallback(qr);
          return;
        }
        
        // Successfully connected
        if (connection === 'open') {
          console.log(`✅ ${shop.name} connected!`);
          this.connectionStates.set(shopId, 'connected');
          this.reconnectAttempts.set(shopId, 0);
          return;
        }
        
        // Connection closed
        if (connection === 'close') {
          const code = lastDisconnect?.error?.output?.statusCode;
          const reason = lastDisconnect?.error?.message || 'unknown';
          
          console.log(`🔌 ${shop.name} disconnected. Code: ${code}, Reason: ${reason}`);
          this.connectionStates.set(shopId, 'disconnected');
          this.connections.delete(shopId);
          
          // Logged out explicitly - need new QR
          if (code === DisconnectReason.loggedOut) {
            console.log(`🚪 ${shop.name} logged out - need new QR`);
            await deleteSession();
            this.qrCallbacks.delete(shopId);
            return;
          }
          
          // Any other reason - reconnect automatically
          const attempts = this.reconnectAttempts.get(shopId) || 0;
          
          // Exponential backoff
          const delays = [5000, 10000, 20000, 60000];
          const delay = delays[Math.min(attempts, delays.length - 1)];
          
          console.log(`🔄 Reconnecting ${shop.name} in ${delay/1000}s (attempt ${attempts + 1})`);
          this.reconnectAttempts.set(shopId, attempts + 1);
          
          setTimeout(async () => {
            if (this.connectionStates.get(shopId) !== 'connected') {
              try {
                await this.connectShop(shopId, qrCallback);
              } catch (err) {
                console.error(`Reconnect failed for ${shop.name}:`, err);
              }
            }
          }, delay);
        }
      });

      // Handle messages - FIX 2: Add to processing queue
      sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const msg = messages[0];
        if (!msg?.message || msg.key.fromMe) return;
        
        // Queue message to limit concurrent processing per shop
        await queueMessage(shopId, async () => {
          try {
            // FIX 4: Add timeout to message handling
            const timeoutPromise = new Promise((_, reject) => 
              setTimeout(() => reject(new Error('Message handling timeout')), 30000)
            );
            await Promise.race([
              this.handleMessage(sock, msg, shop),
              timeoutPromise
            ]);
          } catch (err) {
            console.error(`❌ Message handling error for ${shopId}:`, err.message);
          }
        });
      });

      console.log(`🤖 Connection initialized for ${shop.name}`);
      return sock;

    } catch (error) {
      console.error(`❌ Connection error for ${shopId}:`, error.message);
      this.connectionStates.set(shopId, 'not_started');
      
      // Don't retry if shop doesn't exist
      if (error.message === 'Shop not found') {
        console.log(`🚫 Shop ${shopId} not found in database - stopping retries`);
        this.connectionStates.set(shopId, 'shop_not_found');
        throw error;
      }
      
      throw error;
    }
  }

  async handleMessage(sock, msg, shop) {
    try {
      const from = msg.key.remoteJid;
      const customerPhone = from.split('@')[0];
      
      // FIX: Fetch fresh shop data to get latest products
      // The 'shop' parameter is from connection time and may be stale
      console.log(`🔄 handleMessage: Refreshing shop data for ${shop.id} (current products: ${shop.products?.length || 0})`);
      const freshShop = await getShopCached(shop.id);
      if (freshShop) {
        console.log(`✅ handleMessage: Got fresh shop with ${freshShop.products?.length || 0} products`);
        shop = freshShop;
      } else {
        console.log(`⚠️ handleMessage: Failed to get fresh shop data, using stale data`);
      }
      
      // Extract and normalize text (convert Arabic numbers to English)
      const rawText = msg.message?.conversation || 
                   msg.message?.extendedTextMessage?.text || 
                   msg.message?.imageMessage?.caption || 
                   msg.message?.videoMessage?.caption || '';
      
      const text = normalizeNumbers(rawText);

      // Handle non-text messages (voice, sticker, image without caption, etc.)
      if (!text.trim()) {
        const msgType = Object.keys(msg.message || {})[0];
        const nonTextTypes = ['audioMessage', 'stickerMessage', 'reactionMessage', 'locationMessage', 'contactMessage', 'documentMessage'];
        if (nonTextTypes.includes(msgType) || msgType === 'imageMessage' || msgType === 'videoMessage') {
          await this.safeSendMessage(sock, from,
            `عذراً، لا أستطيع قراءة هذا النوع من الرسائل حالياً 😅\n\n` +
            `يرجى كتابة طلبك نصياً، مثلاً:\n` +
            `📋 *قائمة* - لعرض المنتجات\n` +
            `🛒 *كارت* - لعرض سلتك\n` +
            `✅ *اطلب* - لتأكيد الطلب\n` +
            `❓ *مساعدة* - للمساعدة`, shop.name, shop.id, customerPhone);
        }
        return;
      }

      // Ignore very short meaningless messages (single punctuation, emoji-only, etc.)
      const strippedText = text.replace(/[\s\.\,\!\?\؟\;\:\-\_\(\)\[\]\{\}…\u200f\u200e]/g, '').replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{27BF}\u{FE00}-\u{FEFF}\u{1FA00}-\u{1FAFF}\u{2700}-\u{27BF}\u{200D}\u{20E3}]/gu, '');
      if (strippedText.length === 0) {
        // Pure emoji or punctuation - just acknowledge
        await this.safeSendMessage(sock, from,
          `👋 أهلاً! اكتب *قائمة* لعرض المنتجات أو *مساعدة* للمساعدة`, shop.name, shop.id, customerPhone);
        return;
      }

      console.log(`📩 ${shop.name} - Message from ${customerPhone}: "${text}"`);

      const lowerText = text.toLowerCase().trim();

      // Check pending variant selection
      const pendingVariantKey =
        `pendingvariant:${shop.id}:${customerPhone}` 
      const pendingVariantData = await redis.get(pendingVariantKey)

      if (pendingVariantData) {
        const pendingVariant = typeof pendingVariantData === 'string' ? JSON.parse(pendingVariantData) : pendingVariantData

        // Allow cancel
        if (/^(الغاء|إلغاء|إلغي|الغي|cancel)$/i.test(text.trim())) {
          await redis.del(pendingVariantKey)
          await sock.sendMessage(from, {
            text: 'تم الإلغاء. اكتب *قائمة* لعرض المنتجات.'
          })
          return
        }

        const trimmedText = text.trim()
        const variantGroups = pendingVariant.variants || []
        let variantInfo = null

        // Method 1: Colon format "اللون: أحمر\nالمقاس: L" or "اللون: أحمر، المقاس: L"
        const colonLines = trimmedText.split(/[\n،,]/).filter(l => l.includes(':'))
        if (colonLines.length > 0) {
          variantInfo = colonLines.map(l => l.trim()).join(' - ')
        }

        // Method 2: Direct option value match - customer just types "أحمر" or "L" or "أحمر L"
        if (!variantInfo) {
          const inputWords = trimmedText.split(/[\s،,]+/).map(w => w.trim()).filter(Boolean)
          const matched = {}

          for (let gi = 0; gi < variantGroups.length; gi++) {
            const group = variantGroups[gi]
            for (const opt of group.options) {
              const normalizedOpt = normalizeArabic(opt)
              // Check if any input word matches this option
              for (const word of inputWords) {
                const normalizedWord = normalizeArabic(word)
                if (normalizedWord === normalizedOpt || 
                    normalizedOpt.includes(normalizedWord) || 
                    normalizedWord.includes(normalizedOpt)) {
                  matched[gi] = { name: group.name, value: opt }
                  break
                }
              }
              if (matched[gi]) break
            }
            // Also check full text against each option
            if (!matched[gi]) {
              const normalizedInput = normalizeArabic(trimmedText)
              for (const opt of group.options) {
                if (normalizeArabic(opt) === normalizedInput) {
                  matched[gi] = { name: group.name, value: opt }
                  break
                }
              }
            }
          }

          // Merge with any previous partial selections
          if (pendingVariant.selected) {
            for (const [gi, val] of Object.entries(pendingVariant.selected)) {
              if (!matched[gi]) matched[gi] = val
            }
          }

          const matchedCount = Object.keys(matched).length
          if (matchedCount === variantGroups.length) {
            // All groups matched (possibly combining previous + current) - build variant info
            variantInfo = Object.values(matched).map(m => `${m.name}: ${m.value}`).join(' - ')
          } else if (matchedCount > 0 && matchedCount < variantGroups.length) {
            // Still partial - save merged selections, ask for the rest
            const remaining = variantGroups.filter((_, i) => !matched[i])
            const partialInfo = Object.values(matched).map(m => `✅ ${m.name}: ${m.value}`).join('\n')
            await sock.sendMessage(from, {
              text: `تم اختيار:\n${partialInfo}\n\n` +
                    `يرجى اختيار أيضاً:\n` +
                    remaining.map(g => {
                      const avail = g.options.filter(o => {
                        if (!g.stock) return true
                        const s = g.stock[o]
                        return s === null || s === undefined || s > 0
                      })
                      return `*${g.name}:* ${avail.join('، ')}`
                    }).join('\n') +
                    `\n\nأو اكتب *إلغاء* للرجوع`
            })
            // Save merged selections (previous + current)
            pendingVariant.selected = matched
            await redis.set(pendingVariantKey, JSON.stringify(pendingVariant), { ex: 300 })
            return
          }
        }

        if (variantInfo) {
          await redis.del(pendingVariantKey)
          const product = await prisma.product.findUnique({
            where: { id: pendingVariant.productId }
          })
          if (product) {
            await this.addProductToCartWithVariant(
              sock, from, shop, customerPhone, product, variantInfo
            )
          }
          return
        }

        // Customer input didn't match any option - show friendly reminder (hide out-of-stock)
        const availExample = variantGroups[0]?.options.find(o => {
          if (!variantGroups[0]?.stock) return true
          const s = variantGroups[0].stock[o]
          return s === null || s === undefined || s > 0
        }) || variantGroups[0]?.options[0] || 'أحمر'

        await sock.sendMessage(from, {
          text: `يرجى اختيار من الخيارات التالية:\n\n` +
                variantGroups.map(g => {
                  const avail = g.options.filter(o => {
                    if (!g.stock) return true
                    const s = g.stock[o]
                    return s === null || s === undefined || s > 0
                  })
                  return `*${g.name}:* ${avail.join('، ')}`
                }).join('\n') +
                `\n\n💡 اكتب اسم الخيار مباشرة (مثال: ${availExample})` +
                `\n\nأو اكتب *إلغاء* للرجوع`
        })
        return
      }

      // Check if message is from the mini store website
      if (text.includes('[ORDER_FROM_WEBSITE]')) {
        console.log(`🛒 Website order detected from ${customerPhone}`);
        await this.handleWebsiteOrder(sock, from, text, shop, customerPhone);
        return;
      }

      // HANDLE PENDING CONFIRMATION FIRST
      const pendingKey = `pending:${shop.id}:${customerPhone}`;
      const pendingData = await redis.get(pendingKey);

      if (pendingData) {
        const pending = typeof pendingData === 'string' ? JSON.parse(pendingData) : pendingData;
        const t = text.trim();

        // Confirmed with yes
        if (t.match(/^(نعم|اه|أه|yes|ن|تمام|صح|أجل|بالتأكيد|بالتاكيد)$/i)) {
          await redis.del(pendingKey);
          await this.addProductToCartWithVariant(sock, from, shop, customerPhone, pending[0]);
          return;
        }

        // Chose by number
        if (/^\d+$/.test(t)) {
          const index = parseInt(t) - 1;
          if (index >= 0 && index < pending.length) {
            await redis.del(pendingKey);
            await this.addProductToCartWithVariant(sock, from, shop, customerPhone, pending[index]);
            return;
          }
        }

        // Said no - clear pending and continue normally
        await redis.del(pendingKey);
      }

      // Get conversation context for smarter responses
      const context = await this.getConversationContext(shop.id, customerPhone);
      
      // IMPORTANT: Send welcome message immediately for first-time users
      if (context.messageCount === 0) {
        await this.sendStoreLink(sock, from, shop, customerPhone);
        
        // Update history to mark welcome sent
        await this.updateMessageHistory(shop.id, customerPhone, text, 'user');
        return;
      }
      
      // Update message history for context awareness
      await this.updateMessageHistory(shop.id, customerPhone, text, 'user');

      // Check for order states first - handle name/phone/address collection
      // FIX: Smart state handling - allow cancel and questions during info collection
      const orderState = await redis.get(`order_state:${shop.id}:${customerPhone}`);
      
      // Handle "waiting_for_more" state (after cart summary, asking if they want more items)
      if (orderState === 'waiting_for_more') {
        // Clear the state first
        await redis.del(`order_state:${shop.id}:${customerPhone}`);
        
        if (this.matchesIntent(lowerText, 'no') || this.matchesIntent(lowerText, 'done')) {
          // Customer is done - proceed to collect delivery details
          await this.askForCustomerDetails(sock, from, shop.id, customerPhone, shop);
          return;
        } else if (this.matchesIntent(lowerText, 'yes')) {
          // Customer wants to add more
          await this.safeSendMessage(sock, from,
            `تمام! 👍 اكتب رقم المنتج أو اسمه لإضافته للسلة\n` +
            `أو اكتب *قائمة* لعرض المنتجات 📋`, shop.name, shop.id, customerPhone);
          return;
        }
        // Any other message - let it fall through to normal processing
      }
      
      if (orderState === 'waiting_for_name' || orderState === 'waiting_for_phone' || orderState === 'waiting_for_address') {
        // Check if customer wants to cancel during info collection
        // CRITICAL FIX: Only match EXACT cancel words as standalone commands
        const exactCancelPattern = /^(الغاء|إلغاء|الغي|إلغي|cancel|الغاء الطلب|إلغاء الطلب)$/i;
        if (exactCancelPattern.test(text.trim())) {
          // Clear all order states and cart
          await redis.del(`order_state:${shop.id}:${customerPhone}`);
          await redis.del(`customer_name:${shop.id}:${customerPhone}`);
          await redis.del(`customer_phone:${shop.id}:${customerPhone}`);
          await redis.del(`customer_address:${shop.id}:${customerPhone}`);
          await redis.del(`cart:${shop.id}:${customerPhone}`);
          await redis.del(`msgcount:${shop.id}:${customerPhone}`);
          
          await sock.sendMessage(from, {
            text: `تم إلغاء الطلب بنجاح ✅\n\nنتمنى أن نراك مجدداً! اكتب *قائمة* لتصفح منتجاتنا.` 
          });
          console.log(`🗑️ Order cancelled by ${customerPhone} during info collection`);
          return;
        }
        
        // Check if customer asks a question or needs help during info collection
        const questionWords = /كم|سعر|أسعار|قائمة|menu|مساعدة|help|؟|ايه|ما هو|كيف|منتجات|عندكم|فيه|موجود/;
        if (questionWords.test(lowerText) && orderState !== 'waiting_for_address') {
          // Use AI to answer and remind them to complete order
          console.log(`❓ Question during info collection: "${lowerText}"`);
          
          const cartKey = `cart:${shop.id}:${customerPhone}`;
          const cartData = await redis.get(cartKey);
          let cart = [];
          if (cartData) {
            try {
              cart = typeof cartData === 'string' ? JSON.parse(cartData) : cartData;
            } catch (e) { cart = []; }
          }
          
          const productsList = shop.products
            ? shop.products
                .filter(p => p.isAvailable)
                .slice(0, 10)
                .map((p, i) => `${i+1}. ${p.name} - ${p.price} جنيه`)
                .join('\n')
            : 'جاري تحميل المنتجات...';
          
          const systemPrompt = `أنت مساعد متجر "${shop.name}".
المنتجات المتاحة: ${productsList}
العميل في منتصف إتمام طلبه وله ${cart.length} منتج في السلة.
أجب على سؤاله بإيجاز (جملتين فقط) ثم ذكّره بلطف بإكمال بياناته.`;
          
          const aiReply = await this.getGroqResponse(
            text, 
            shop, 
            { hasItems: cart.length > 0, itemCount: cart.length }, 
            'neutral', 
            'question', 
            customerPhone, 
            ''
          );
          
          if (aiReply) {
            await sock.sendMessage(from, { text: aiReply });
            
            // Wait then remind to complete order
            setTimeout(async () => {
              let reminderMsg = `📝 لإتمام طلبك، يرجى إرسال `;
              if (orderState === 'waiting_for_name') reminderMsg += `*اسمك*`;
              else if (orderState === 'waiting_for_phone') reminderMsg += `*رقم هاتفك*`;
              else if (orderState === 'waiting_for_address') reminderMsg += `*عنوانك*`;
              reminderMsg += `\n\nأو اكتب *إلغاء* لإلغاء الطلب`;
              
              await sock.sendMessage(from, { text: reminderMsg });
            }, 2000);
          } else {
            // Fallback if AI fails
            await sock.sendMessage(from, {
              text: `حسناً، سأجيب على سؤالك ثم نكمل الطلب 📝\n\nاكتب *قائمة* لرؤية المنتجات وأسعارها.`
            });
          }
          return;
        }
        
        // Otherwise process as normal info input (name, phone, or address)
        if (orderState === 'waiting_for_name') {
          await this.handleNameInput(sock, from, shop.id, customerPhone, shop, text.trim());
          return;
        } else if (orderState === 'waiting_for_phone') {
          let phone = text.replace(/[\s\-\+]/g, '');
          // Normalize Egyptian phone formats: +201..., 00201..., 201..., 01...
          if (/^00201\d{9}$/.test(phone)) phone = '0' + phone.slice(4);
          else if (/^201\d{9}$/.test(phone)) phone = '0' + phone.slice(2);
          else if (/^01\d{9}$/.test(phone)) { /* already correct */ }
          else if (/^1\d{9}$/.test(phone)) phone = '0' + phone;
          
          if (/^01\d{9}$/.test(phone)) {
            await this.handlePhoneInput(sock, from, shop.id, customerPhone, shop, phone);
          } else {
            await this.safeSendMessage(sock, from, 
              `⚠️ رقم الهاتف غير صحيح\n\n` +
              `يرجى كتابة الرقم بالصيغة الصحيحة:\n` +
              `01012345678 أو +201012345678 📱\n` +
              `أو اكتب *إلغاء* لإلغاء الطلب`, shop.name, shop.id, customerPhone);
          }
          return;
        } else if (orderState === 'waiting_for_address') {
          // Check if customer doesn't know their address or is confused
          const dontKnowPatterns = /مش عارف|مش فاكر|لا اعرف|لا أعرف|معرفش|مش متأكد|مش متاكد|لسه|مش عندي|ماعرفش/;
          if (dontKnowPatterns.test(text.trim())) {
            await this.safeSendMessage(sock, from,
              `لا مشكلة! 😊\n\n` +
              `يمكنك كتابة أقرب علامة مميزة أو اسم المنطقة فقط\n` +
              `مثال: *المعادي - بجوار مسجد الفتح*\n\n` +
              `أو اكتب *إلغاء* لإلغاء الطلب`, shop.name, shop.id, customerPhone);
            return;
          }
          // Validate address minimum length
          const cleanAddress = text.replace(/^عنوان[:\s]*/i, '').replace(/^العنوان[:\s]*/i, '').replace(/^address[:\s]*/i, '').trim();
          if (cleanAddress.length < 5) {
            await this.safeSendMessage(sock, from,
              `⚠️ العنوان قصير جداً!\n\n` +
              `يرجى كتابة عنوان أكثر تفصيلاً لنتمكن من التوصيل:\n` +
              `مثال: *شارع التحرير، مدينة نصر، القاهرة*\n\n` +
              `أو اكتب *إلغاء* لإلغاء الطلب`, shop.name, shop.id, customerPhone);
            return;
          }
          await this.handleAddressInput(sock, from, shop.id, customerPhone, shop, text);
          return;
        }
      }
      // FIX 3: Check for frustration and repeating messages - BUT ONLY FOR UNKNOWN MESSAGES
      console.log(`🔍 Processing message: "${lowerText}"`);
      
      // CRITICAL FIX: Check for cancel confirmation FIRST, before yes/no intents
      const cancelConfirmKey = `cancel_confirm:${shop.id}:${customerPhone}`;
      const pendingConfirm = await redis.get(cancelConfirmKey);
      if (pendingConfirm === 'waiting') {
        console.log(`✓ Cancel confirmation state detected`);
        if (this.matchesIntent(lowerText, 'yes')) {
          console.log(`✓ Confirming cancel - clearing cart`);
          await this.clearCart(sock, from, shop.id, customerPhone, shop.name);
          await redis.del(cancelConfirmKey);
          return;
        } else if (this.matchesIntent(lowerText, 'no')) {
          console.log(`✓ Canceling clear - keeping cart`);
          await redis.del(cancelConfirmKey);
          await this.showCart(sock, from, shop.id, customerPhone, shop);
          return;
        } else {
          // Any other message in confirmation state - remind them
          await this.safeSendMessage(sock, from, 
            `⚠️ هل تريد مسح السلة؟\n\n` +
            `اكتب *نعم* لتأكيد المسح\n` +
            `اكتب *لا* للإلغاء`, shop.name, shop.id, customerPhone);
          return;
        }
      }
      
      // ===== WORKING HOURS CHECK =====
      const shopOpen = isShopOpen(shop);
      if (!shopOpen) {
        // Allow greetings and working hours questions even when closed
        const isGreeting = this.matchesIntent(lowerText, 'greeting');
        const isHoursQ = this.matchesIntent(lowerText, 'working_hours');

        if (isGreeting) {
          // Respond to greeting but mention shop is closed
          const nextOpen = getNextOpenTime(shop);
          const schedule = getWorkingHoursSchedule(shop);
          const appUrl = process.env.APP_URL || process.env.RAILWAY_STATIC_URL || '';
          const storeLink = appUrl ? `${appUrl}/store/${shop.id}` : '';
          await this.safeSendMessage(sock, from,
            `أهلاً بك! 👋\n\n` +
            `عذراً، المتجر مغلق حالياً 🔴\n` +
            (nextOpen ? `🕐 هنفتح ${nextOpen}\n\n` : '\n') +
            `📅 *ساعات العمل:*\n${schedule}` +
            (storeLink ? `\n\n🛍️ تصفح منتجاتنا: ${storeLink}` : ''),
            shop.name, shop.id, customerPhone);
          return;
        }

        if (isHoursQ) {
          const schedule = getWorkingHoursSchedule(shop);
          const nextOpen = getNextOpenTime(shop);
          await this.safeSendMessage(sock, from,
            `📅 *ساعات العمل:*\n${schedule}\n\n` +
            `المتجر مغلق حالياً 🔴\n` +
            (nextOpen ? `🕐 هنفتح ${nextOpen}` : ''),
            shop.name, shop.id, customerPhone);
          return;
        }

        // For all other messages when closed
        const nextOpen = getNextOpenTime(shop);
        const schedule = getWorkingHoursSchedule(shop);
        const appUrl = process.env.APP_URL || process.env.RAILWAY_STATIC_URL || '';
        const storeLink = appUrl ? `${appUrl}/store/${shop.id}` : '';
        await this.safeSendMessage(sock, from,
          `عذراً، المتجر مغلق حالياً 🔴\n` +
          (nextOpen ? `🕐 هنفتح ${nextOpen}\n\n` : '\n') +
          `📅 *ساعات العمل:*\n${schedule}` +
          (storeLink ? `\n\n🛍️ يمكنك تصفح منتجاتنا: ${storeLink}` : ''),
          shop.name, shop.id, customerPhone);
        return;
      }

      // Track message count for AI takeover decision
      const msgCountKey = `msgcount:${shop.id}:${customerPhone}`;
      const msgCount = parseInt(await redis.get(msgCountKey) || '0') + 1;
      await redis.set(msgCountKey, msgCount, { ex: 3600 });
      
      // Check for product variant questions (e.g., "ايه الالوان المتاحه من الهودي")
      const variantQueryWords = ['الوان', 'لون', 'مقاس', 'مقاسات', 'حجم', 'احجام', 'المتاحه', 'المتاح', 'الخيارات'];
      const hasVariantQuery = variantQueryWords.some(w => lowerText.includes(w));
      if (hasVariantQuery && shop.products && shop.products.length > 0) {
        const availableProducts = shop.products.filter(p => p.isAvailable);
        const variantMatches = findBestMatch(text, availableProducts);
        if (variantMatches.length > 0 && variantMatches[0].score >= 0.5) {
          const product = variantMatches[0].product;
          if (product.variants) {
            let vGroups = [];
            try { vGroups = typeof product.variants === 'string' ? JSON.parse(product.variants) : product.variants; } catch {}
            if (vGroups.length > 0) {
              let msg = `📦 الخيارات المتاحة لـ *${product.name}*:\n\n`;
              for (const group of vGroups) {
                const availableOpts = (group.options || []).filter(opt => {
                  const stock = group.stock?.[opt];
                  return stock === null || stock === undefined || stock > 0;
                });
                if (availableOpts.length > 0) {
                  msg += `*${group.name}:* ${availableOpts.join(' - ')}\n`;
                }
              }
              msg += `\n💰 السعر: ${product.price} جنيه`;
              msg += `\n\nاكتب اسم المنتج لإضافته للسلة 🛒`;
              console.log(`✓ Matched: variant question for "${product.name}"`);
              await this.safeSendMessage(sock, from, msg, shop.name, shop.id, customerPhone);
              return;
            }
          }
        }
      }

      // IMPORTANT: Check basic commands FIRST before any AI logic
      if (this.matchesIntent(lowerText, 'menu')) {
        console.log(`✓ Matched: menu`);
        await this.sendProductsList(sock, from, shop, customerPhone, 1);
        return;
      } else if (this.matchesIntent(lowerText, 'delivery')) {
        console.log(`✓ Matched: delivery question`);
        await this.handleDeliveryQuestion(sock, from, shop, customerPhone, text);
        return;
      } else if (this.matchesIntent(lowerText, 'order_status')) {
        console.log(`✓ Matched: order status`);
        await this.handleOrderStatus(sock, from, shop, customerPhone);
        return;
      } else if (this.matchesIntent(lowerText, 'cart')) {
        console.log(`✓ Matched: cart`);
        await this.showCart(sock, from, shop.id, customerPhone, shop);
        return;
      } else if (this.matchesIntent(lowerText, 'order')) {
        console.log(`✓ Matched: order`);
        await this.askForMoreItems(sock, from, shop.id, customerPhone, shop);
        return;
      } else if (this.matchesIntent(lowerText, 'no')) {
        console.log(`✓ Matched: no`);
        await this.handleNoResponse(sock, from, shop, customerPhone);
        return;
      } else if (this.matchesIntent(lowerText, 'yes')) {
        console.log(`✓ Matched: yes`);
        await this.handleYesResponse(sock, from, shop, customerPhone, context);
        return;
      } else if (lowerText.startsWith('عنوان:') || lowerText.startsWith('العنوان:') || lowerText.startsWith('address:')) {
        console.log(`✓ Matched: address input`);
        await this.handleAddressInput(sock, from, shop.id, customerPhone, shop, text);
        return;
      } else if (/^(\+?0{0,2}2?0?1\d{9})$/.test(text.replace(/[\s\-]/g, ''))) {
        console.log(`✓ Matched: phone number`);
        let phone = text.replace(/[\s\-\+]/g, '');
        if (/^00201\d{9}$/.test(phone)) phone = '0' + phone.slice(4);
        else if (/^201\d{9}$/.test(phone)) phone = '0' + phone.slice(2);
        else if (/^1\d{9}$/.test(phone)) phone = '0' + phone;
        await this.handlePhoneInput(sock, from, shop.id, customerPhone, shop, phone);
        return;
      } else if (lowerText.startsWith('صفحة ') || lowerText.startsWith('page ')) {
        console.log(`✓ Matched: page navigation`);
        const pageNum = parseInt(text.split(' ')[1]) || 1;
        await this.sendProductsList(sock, from, shop, customerPhone, pageNum);
        return;
      } else if (this.matchesIntent(lowerText, 'done')) {
        console.log(`✓ Matched: done (خلاص/بس/كده/تم)`);
        await this.handleDoneResponse(sock, from, shop, customerPhone);
        return;
      } else if (this.matchesIntent(lowerText, 'thanks')) {
        console.log(`✓ Matched: thanks`);
        await this.handleThanksResponse(sock, from, shop, customerPhone, context);
        return;
      } else if (this.matchesIntent(lowerText, 'cancel')) {
        console.log(`✓ Matched: cancel`);
        await this.handleCancelCommand(sock, from, shop, customerPhone, context);
        return;
      } else if (this.matchesIntent(lowerText, 'discount')) {
        console.log(`✓ Matched: discount/offer question`);
        await this.handleDiscountQuestion(sock, from, shop, customerPhone);
        return;
      } else if (this.matchesIntent(lowerText, 'payment')) {
        console.log(`✓ Matched: payment method question`);
        await this.handlePaymentQuestion(sock, from, shop, customerPhone);
        return;
      } else if (this.matchesIntent(lowerText, 'working_hours')) {
        console.log(`✓ Matched: working hours question`);
        await this.handleWorkingHoursQuestion(sock, from, shop, customerPhone);
        return;
      } else if (this.matchesIntent(lowerText, 'location')) {
        console.log(`✓ Matched: location/branch question`);
        await this.handleLocationQuestion(sock, from, shop, customerPhone);
        return;
      } else if (this.matchesIntent(lowerText, 'return_policy')) {
        console.log(`✓ Matched: return/warranty question`);
        await this.handleReturnPolicyQuestion(sock, from, shop, customerPhone);
        return;
      } else if (this.matchesIntent(lowerText, 'recommend')) {
        console.log(`✓ Matched: recommendation request`);
        await this.handleRecommendation(sock, from, shop, customerPhone);
        return;
      } else if (this.matchesIntent(lowerText, 'store_link')) {
        console.log(`✓ Matched: store link request`);
        await this.sendStoreLink(sock, from, shop, customerPhone);
        return;
      } else if (this.matchesIntent(lowerText, 'talk_to_human')) {
        console.log(`✓ Matched: talk to human request`);
        await this.handleTalkToHuman(sock, from, shop, customerPhone);
        return;
      } else if (this.matchesIntent(lowerText, 'whats_new')) {
        console.log(`✓ Matched: what's new question`);
        await this.handleWhatsNew(sock, from, shop, customerPhone);
        return;
      } else if (this.matchesIntent(lowerText, 'affirmative')) {
        console.log(`✓ Matched: affirmative (ok/alright)`);
        await this.handleAffirmative(sock, from, shop, customerPhone, context);
        return;
      } else if (lowerText.startsWith('شيل ') || lowerText.startsWith('احذف ') || lowerText.startsWith('امسح ')) {
        console.log(`✓ Matched: remove item command`);
        const itemName = text.substring(text.indexOf(' ') + 1).trim();
        await this.removeFromCart(sock, from, shop.id, customerPhone, itemName, shop);
        return;
      } else if (/^(زود|نقص|غير)\s/.test(lowerText)) {
        console.log(`✓ Matched: change quantity command`);
        await this.handleChangeQuantity(sock, from, shop, customerPhone, text);
        return;
      } else if (/^\d+$/.test(text)) {
        console.log(`✓ Matched: product number`);
        await this.addToCart(sock, from, shop.id, customerPhone, parseInt(text), shop);
        return;
      } else if (/\d+/.test(text.trim()) && text.trim().length > 1 && !/^\d+$/.test(text.trim())) {
        // Quantity + product name in various formats:
        // "2 شاورما", "شاورما 2", "عايز 2 شاورما", "هاتلي 3 بيتزا"
        const embeddedMatch = text.trim().match(/^(\d+)\s+(.+)/) || 
                              text.trim().match(/^(.+)\s+(\d+)$/) ||
                              text.trim().match(/^.+?\s+(\d+)\s+(.+)/);
        if (embeddedMatch) {
          let qty, productName;
          if (/^\d/.test(text.trim())) {
            qty = parseInt(embeddedMatch[1]);
            productName = embeddedMatch[2];
          } else if (/\d+$/.test(text.trim())) {
            productName = embeddedMatch[1];
            qty = parseInt(embeddedMatch[2]);
          } else {
            // Embedded: "عايز 2 شاورما" → group1=2, group2=شاورما
            qty = parseInt(embeddedMatch[1]);
            productName = embeddedMatch[2];
          }
          if (qty > 0 && qty <= 20 && productName.length > 1) {
            console.log(`✓ Matched: quantity + product name: ${qty}x "${productName}"`);
            await this.addToCartByNameWithQty(sock, from, shop, customerPhone, productName, qty);
            return;
          }
        }
      }
      
      // NAME-BASED ORDERING: Check if text matches a product name
      const matches = findBestMatch(text, shop.products);
      
      // Single exact or very high confidence match - add directly
      if (matches.length >= 1 && matches[0].score >= 0.85) {
        const product = matches[0].product;
        const productIndex = shop.products
          .filter(p => p.isAvailable)
          .indexOf(product) + 1;
        console.log(`✓ Matched: product name "${product.name}" (score: ${matches[0].score.toFixed(2)})`);
        await this.addToCart(sock, from, shop.id, customerPhone, productIndex, shop);
        return;
      }
      
      // Multiple possible matches - ask customer to choose
      if (matches.length >= 2 && matches[0].score >= 0.65) {
        const top3 = matches.slice(0, 3);
        
        // Save pending in Redis
        const pendingKey = `pending:${shop.id}:${customerPhone}`;
        await redis.set(pendingKey, JSON.stringify(
          top3.map(m => ({
            productId: m.product.id,
            name: m.product.name,
            price: m.product.price
          }))
        ), { ex: 300 });
        
        const confirmMsg =
          `هل تقصد أحد هذه المنتجات؟\n\n` +
          top3.map((m, i) =>
            `${i + 1}. ${m.product.name} - ${m.product.price} جنيه`
          ).join('\n') +
          `\n\nاكتب الرقم للإضافة إلى سلتك، أو *لا* لعرض القائمة كاملة.`;
        
        await sock.sendMessage(from, { text: confirmMsg });
        console.log(`❓ Multiple matches for "${text}", asking customer to choose`);
        return;
      }
      
      // One match with medium confidence - confirm first
      if (matches.length === 1 && matches[0].score >= 0.65) {
        const product = matches[0].product;
        
        const pendingKey = `pending:${shop.id}:${customerPhone}`;
        await redis.set(pendingKey, JSON.stringify([{
          productId: product.id,
          name: product.name,
          price: product.price
        }]), { ex: 300 });
        
        await sock.sendMessage(from, {
          text: `هل تقصد *${product.name}* بسعر ${product.price} جنيه؟\n\n` +
                `اكتب *نعم* للإضافة إلى سلتك\n` +
                `أو اكتب *لا* لعرض القائمة كاملة`
        });
        console.log(`❓ Single match for "${text}" (score: ${matches[0].score.toFixed(2)}), asking confirmation`);
        return;
      }
      
      // Only for UNKNOWN messages: Check if customer is frustrated or repeating
      const emotion = this.detectEmotion(lowerText);
      const isFrustrated = emotion === 'frustrated' || emotion === 'confused';
      
      // Check if same message repeated (from history)
      const historyKey = `chat_history:${shop.id}:${customerPhone}`;
      const historyData = await redis.get(historyKey);
      let messages = [];
      if (historyData) {
        try {
          messages = typeof historyData === 'string' ? JSON.parse(historyData) : historyData;
        } catch (e) { messages = []; }
      }
      const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
      const isRepeating = lastMessage && lastMessage.text === text && msgCount > 3;
      
      // Use AI if customer is frustrated, repeating, or sent many messages with no order
      const shouldUseAI = isFrustrated || isRepeating || (msgCount > 5 && !context.hasItems);
      
      if (shouldUseAI) {
        console.log(`🤖 AI takeover: emotion=${emotion}, repeating=${isRepeating}, msgCount=${msgCount}`);
        await this.handleWithAI(sock, from, text, shop, customerPhone);
        return;
      }
      
      // For unknown messages that don't need AI, use smart response
      console.log(`→ No command match, using smart response`);
      await this.handleSmartResponse(sock, from, shop, customerPhone, text, context);

    } catch (error) {
      console.error(`❌ Error handling message:`, error.message);
    }
  }

  // Get conversation context for smarter responses
  async getConversationContext(shopId, customerPhone) {
    try {
      const historyKey = `chat_history:${shopId}:${customerPhone}`;
      const cartKey = `cart:${shopId}:${customerPhone}`;
      const nameKey = `customer_name:${shopId}:${customerPhone}`;
      
      const [history, cart, name] = await Promise.all([
        redis.get(historyKey),
        redis.get(cartKey),
        redis.get(nameKey)
      ]);
      
      let items = [];
      if (cart) {
        try {
          if (typeof cart === 'string') {
            items = JSON.parse(cart);
          } else if (typeof cart === 'object') {
            items = cart;
          }
        } catch (e) { items = []; }
      }
      
      let messages = [];
      if (history) {
        try {
          if (typeof history === 'string') {
            messages = JSON.parse(history);
          } else if (typeof history === 'object') {
            messages = history;
          }
        } catch (e) { messages = []; }
      }
      const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
      
      return {
        name: name || null,
        hasItems: items.length > 0,
        itemCount: items.length,
        totalValue: items.reduce((sum, i) => sum + i.price * i.quantity, 0),
        messageCount: messages.length,
        lastMessageTime: lastMessage?.time || null,
        isReturningCustomer: messages.length > 3,
        lastIntent: lastMessage?.intent || null
      };
    } catch (error) {
      return { hasItems: false, itemCount: 0, totalValue: 0, messageCount: 0, isReturningCustomer: false };
    }
  }

  // Update message history for context
  async updateMessageHistory(shopId, customerPhone, text, sender, intent = null) {
    try {
      const historyKey = `chat_history:${shopId}:${customerPhone}`;
      let history = await redis.get(historyKey);
      let messages = [];
      
      if (history) {
        try {
          // Handle both string and object responses from Redis
          if (typeof history === 'string') {
            messages = JSON.parse(history);
          } else if (typeof history === 'object') {
            messages = history;
          }
        } catch (e) {
          console.log('⚠️ History parse error, resetting:', e.message);
          messages = [];
        }
      }
      
      messages.push({
        text: text.slice(0, 100), // Keep it short
        sender,
        time: Date.now(),
        intent
      });
      
      // Keep only last 10 messages
      if (messages.length > 10) messages = messages.slice(-10);
      
      await redis.set(historyKey, JSON.stringify(messages), { ex: 86400 }); // 24 hours
    } catch (error) {
      console.log('History update error:', error.message);
    }
  }

  async safeSendMessage(sock, to, message, shopName, shopId, customerPhone) {
    try {
      // Rate limit: prevent rapid-fire identical messages (3 second cooldown)
      if (shopId && customerPhone) {
        const lastMsgKey = `lastmsg:${shopId}:${customerPhone}`;
        const lastMsg = await redis.get(lastMsgKey);
        
        if (lastMsg === message) {
          // Same message within cooldown - send a brief friendly variation instead of blocking
          const variations = [
            'تم ✅',
            'تمام 👍',
            'جاري المتابعة ✅',
          ];
          message = variations[Math.floor(Math.random() * variations.length)]
        }
        
        // Save with short cooldown (30 seconds)
        await redis.set(lastMsgKey, message, { ex: 30 });
      }
      
      const result = await sock.sendMessage(to, { text: message });
      console.log(`✅ Message sent to ${to}: "${message.slice(0, 50)}${message.length > 50 ? '...' : ''}"`);
      return { duplicate: false, sent: true, result };
    } catch (error) {
      console.error(`❌ Failed to send message to ${to}:`, error.message);
      return { duplicate: false, sent: false, error };
    }
  }

  async sendStoreLink(sock, from, shop, customerPhone) {
    const baseUrl = process.env.APP_URL || `https://${process.env.RAILWAY_STATIC_URL || 'your-app.railway.app'}`;
    const storeUrl = `${baseUrl}/store/${shop.id}`;
    
    const welcomeMsg = 
      `أهلاً وسهلاً! مرحباً بك في *${shop.name}*\n\n` +
      `*أنا ذكي، موظف خدمة العملاء*\n` +
      `أفهم أوامرك وأساعدك في الطلب بسرعة وسهولة.\n\n` +
      `🛍️ *تصفح متجرنا:*\n` +
      `${storeUrl}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `*كيفية الاستخدام:*\n\n` +
      `📋 افتح الرابط أعلاه لرؤية جميع المنتجات\n` +
      `🛒 اختر المنتجات وأضفها إلى السلة\n` +
      `✅ اضغط "أرسل الطلب" وسيتم إرساله تلقائياً\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `أو اكتب رقم المنتج مباشرة هنا`;
    
    await this.safeSendMessage(sock, from, welcomeMsg, shop.name, shop.id, customerPhone);
    console.log(`🎉 Store link sent to ${customerPhone}`);
    
    // Update history
    await this.updateMessageHistory(shop.id, customerPhone, 'first_message', 'user');
    await this.updateMessageHistory(shop.id, customerPhone, welcomeMsg, 'bot', 'welcome');
  }

  async sendProductsList(sock, from, shop, customerPhone, page = 1) {
    // Send store link instead of text list
    await this.sendStoreLink(sock, from, shop, customerPhone);
  }

  async addToCart(sock, from, shopId, customerPhone, productNum, shop) {
    try {
      const products = shop.products.filter(p => p.isAvailable);
      
      // Check if no products available
      if (products.length === 0) {
        await this.safeSendMessage(sock, from, "لا توجد منتجات متاحة حالياً. يرجى المحاولة لاحقاً.", shop.name);
        return;
      }
      
      const product = products[productNum - 1];
      
    // Check if product number is out of range
      if (!product) {
        // FIX 5: Friendly product not found message
        await this.safeSendMessage(sock, from, 
          "عذراً، هذا الرقم غير موجود في قائمتنا 😊\nاكتب *قائمة* لرؤية المنتجات المتاحة.", shop.name, shopId, customerPhone);
        return;
      }

      // Use the new addProductToCartWithVariant method (handles variant selection if needed)
      await this.addProductToCartWithVariant(
        sock, from, shop, customerPhone, product
      );
    } catch (error) {
      console.error(`❌ Error in addToCart:`, error);
      await this.safeSendMessage(sock, from, "❌ حدث خطأ. يرجى المحاولة مرة أخرى.", shop.name);
    }
  }

  async showCart(sock, from, shopId, customerPhone, shop) {
    try {
      const cartKey = `cart:${shopId}:${customerPhone}`;
      let cart;
      try {
        cart = await redis.get(cartKey);
      } catch (e) {
        cart = null;
      }
      
      let items = [];
      if (cart) {
        try {
          if (typeof cart === 'string') {
            items = JSON.parse(cart);
          } else if (typeof cart === 'object') {
            items = cart;
          }
        } catch (e) {
          items = [];
        }
      }

      if (items.length === 0) {
        // FIX 5: Friendly empty cart message
        await this.safeSendMessage(sock, from, 
          "سلتك فارغة حالياً 🛒\nاكتب *قائمة* لاستعراض منتجاتنا واختيار ما يناسبك!", shop.name);
        return;
      }

      let total = 0;
      let message = `📦 *سلتك الحالية:*\n\n`;
      items.forEach((item, i) => {
        const subtotal = item.price * item.quantity;
        total += subtotal;
        message += `  ${i + 1}. *${item.name}*` +
          (item.variantInfo ? ` _(${item.variantInfo})_` : '') +
          ` — ${item.quantity} حبة × ${item.price} = *${subtotal} جنيه*\n`;
      });
      message += `\n💰 *الإجمالي: ${total} جنيه*\n\n`;
      message += `🚀 اكتب *اطلب* — لتأكيد الطلب\n`;
      message += `📋 اكتب *قائمة* — لإضافة المزيد\n`;
      message += `❌ اكتب *إلغاء* — لتفريغ السلة`;

      await this.safeSendMessage(sock, from, message, shop.name, shopId, customerPhone);
    } catch (error) {
      console.error(`❌ Error in showCart:`, error);
      await this.safeSendMessage(sock, from, "عذراً، حدث خطأ. يرجى المحاولة مرة أخرى 🙏", shop.name);
    }
  }

  async clearCart(sock, from, shopId, customerPhone, shopName) {
    const cartKey = `cart:${shopId}:${customerPhone}`;
    await redis.del(cartKey);
    // FIX 5: Friendly cancel success message
    await this.safeSendMessage(sock, from, 
      "تم مسح سلتك بنجاح ✅\nنتمنى أن نراك مجدداً! اكتب *قائمة* لتصفح منتجاتنا.", shopName, shopId, customerPhone);
  }

  // NEW: Remove item from cart
  async removeFromCart(sock, from, shopId, customerPhone, itemName, shop) {
    try {
      const cartKey = `cart:${shopId}:${customerPhone}`;
      let cart = await redis.get(cartKey);
      let items = [];
      if (cart) {
        try {
          items = typeof cart === 'string' ? JSON.parse(cart) : cart;
        } catch (e) { items = []; }
      }

      if (items.length === 0) {
        await this.safeSendMessage(sock, from, 
          "السلة فارغة بالفعل! 🛒\nاكتب *قائمة* لتصفح منتجاتنا.", shop.name, shopId, customerPhone);
        return;
      }

      // Find item by name (partial match)
      const itemIndex = items.findIndex(item => 
        item.name.toLowerCase().includes(itemName.toLowerCase()) ||
        itemName.toLowerCase().includes(item.name.toLowerCase())
      );

      if (itemIndex === -1) {
        await this.safeSendMessage(sock, from, 
          `لم أجد "${itemName}" في السلة 😕\n\n` +
          `اكتب *كارت* لعرض محتويات السلة.`, shop.name, shopId, customerPhone);
        return;
      }

      const removedItem = items[itemIndex];
      items.splice(itemIndex, 1);

      if (items.length === 0) {
        await redis.del(cartKey);
        await this.safeSendMessage(sock, from, 
          `تمت إزالة ${removedItem.name} من السلة ✅\n\n` +
          `الآن السلة فارغة. اكتب *قائمة* لاختيار منتجات جديدة.`, shop.name, shopId, customerPhone);
      } else {
        await redis.set(cartKey, JSON.stringify(items), { ex: 3600 });
        const total = items.reduce((sum, i) => sum + i.price * i.quantity, 0);
        await this.safeSendMessage(sock, from, 
          `تمت إزالة ${removedItem.name} من السلة ✅\n\n` +
          `لديك الآن ${items.length} منتجات بإجمالي ${total} جنيه.\n` +
          `اكتب *كارت* لعرض السلة.`, shop.name, shopId, customerPhone);
      }
    } catch (error) {
      console.error(`❌ Error in removeFromCart:`, error);
      await this.safeSendMessage(sock, from, "عذراً، حدث خطأ أثناء إزالة المنتج 🙏", shop.name);
    }
  }

  async confirmOrder(sock, from, shopId, customerPhone, shop) {
    // This is the OLD method - redirect to details collection
    await this.askForCustomerDetails(sock, from, shopId, customerPhone, shop);
  }

  // Handle "لا" response with context awareness
  async handleNoResponse(sock, from, shop, customerPhone) {
    const cartKey = `cart:${shop.id}:${customerPhone}`;
    let cart = await redis.get(cartKey);
    let items = [];
    if (cart) {
      try {
        items = typeof cart === 'string' ? JSON.parse(cart) : cart;
      } catch (e) { items = []; }
    }
    
    if (items.length === 0) {
      await this.safeSendMessage(sock, from, 
        `🛒 السلة فارغة! \n\n` +
        `هل ترغب في رؤية منتجاتنا؟ اكتب "قائمة" واختر ما يناسبك 😊`, shop.name);
    } else {
      const total = items.reduce((sum, i) => sum + i.price * i.quantity, 0);
      await this.safeSendMessage(sock, from,
        `💡 حسناً! لديك ${items.length} منتج في السلة بإجمالي ${total} جنيه\n\n` +
        `سنبدأ الآن بتسجيل بيانات التوصيل... 📝`, shop.name);
      await this.askForCustomerDetails(sock, from, shop.id, customerPhone, shop);
    }
  }

  // Handle "ايوه" response with smart suggestions
  async handleYesResponse(sock, from, shop, customerPhone, context) {
    const suggestions = context.hasItems 
      ? `ممتاز! 👌 لديك ${context.itemCount} منتجات في السلة\n\n`
      : `رائع! 👏\n\n`;
    
    await this.safeSendMessage(sock, from, 
      suggestions + 
      `اكتب رقم المنتج الذي تريده، أو اكتب "قائمة" لرؤية جميع المنتجات 📋`, shop.name);
  }

  // Smart cancel with empathy - ENHANCED with confirmation
  async handleCancelCommand(sock, from, shop, customerPhone, context = {}) {
    const cartKey = `cart:${shop.id}:${customerPhone}`;
    let cart = await redis.get(cartKey);
    let items = [];
    if (cart) {
      try {
        items = typeof cart === 'string' ? JSON.parse(cart) : cart;
      } catch (e) { items = []; }
    }
    
    // If cart is empty, just inform the user
    if (items.length === 0) {
      await this.safeSendMessage(sock, from, 
        "سلتك فارغة بالفعل! 🛒\n\nاكتب *قائمة* لتصفح منتجاتنا.", shop.name, shop.id, customerPhone);
      return;
    }
    
    // Check if user already confirmed cancellation
    const cancelConfirmKey = `cancel_confirm:${shop.id}:${customerPhone}`;
    const pendingConfirm = await redis.get(cancelConfirmKey);
    
    if (pendingConfirm === 'waiting') {
      // User confirmed - clear the cart
      await redis.del(cartKey);
      await redis.del(cancelConfirmKey);
      await this.safeSendMessage(sock, from, 
        "تم مسح سلتك بنجاح ✅\nنتمنى أن نراك مجدداً! اكتب *قائمة* لتصفح منتجاتنا.", shop.name, shop.id, customerPhone);
      return;
    }
    
    // Ask for confirmation first
    const total = items.reduce((sum, i) => sum + i.price * i.quantity, 0);
    await redis.set(cancelConfirmKey, 'waiting', { ex: 300 }); // 5 minute expiry
    
    await this.safeSendMessage(sock, from, 
      `⚠️ هل أنت متأكد من مسح السلة؟\n\n` +
      `لديك ${items.length} منتج بإجمالي ${total} جنيه\n\n` +
      `اكتب *نعم* لتأكيد المسح\n` +
      `اكتب *لا* للإلغاء والاحتفاظ بالسلة`, shop.name, shop.id, customerPhone);
  }

  // Handle orders coming from the mini store website
  async handleWebsiteOrder(sock, from, text, shop, customerPhone) {
    console.log(`🛒 Processing website order from ${customerPhone}`);
    
    // Parse the order message
    const lines = text.split('\n').filter(l => 
      l.trim() && 
      !l.includes('━') && 
      !l.includes('طلب جديد') &&
      !l.includes('الإجمالي') &&
      !l.includes('[ORDER_FROM_WEBSITE]')
    );
    
    const cart = [];
    
    for (const line of lines) {
      // Format: "اسم المنتج (اللون: أحمر) × 2" or "اسم المنتج × 2"
      const match = line.match(/^(.+?)\s*(?:\(([^)]+)\))?\s*×\s*(\d+)$/);
      if (!match) continue;
      
      const productName = match[1].trim();
      const variantInfo = match[2] ? match[2].trim() : null;
      const quantity = parseInt(match[3]);
      
      const product = shop.products.find(p => 
        p.name === productName && p.isAvailable
      );
      
      if (product) {
        cart.push({
          productId: product.id,
          name: product.name,
          price: product.price,
          quantity,
          variantInfo  // Include variant info in cart
        });
      }
    }
    
    if (cart.length === 0) {
      await sock.sendMessage(from, {
        text: 'عذراً، لم نتمكن من قراءة طلبك. يرجى المحاولة مرة أخرى أو التواصل معنا مباشرة.'
      });
      return;
    }
    
    // MERGE with existing bot cart instead of replacing
    const cartKey = `cart:${shop.id}:${customerPhone}`;
    const existingCartData = await redis.get(cartKey);
    let existingCart = [];
    if (existingCartData) {
      try {
        existingCart = typeof existingCartData === 'string' ? JSON.parse(existingCartData) : existingCartData;
      } catch (e) { existingCart = []; }
    }
    
    // Merge: if same product+variant exists, increase quantity; otherwise append
    for (const newItem of cart) {
      const key = newItem.variantInfo ? `${newItem.productId}__${newItem.variantInfo}` : newItem.productId;
      const existingIndex = existingCart.findIndex(i => {
        const existKey = i.variantInfo ? `${i.productId}__${i.variantInfo}` : i.productId;
        return existKey === key;
      });
      
      if (existingIndex >= 0) {
        existingCart[existingIndex].quantity += newItem.quantity;
      } else {
        existingCart.push({ ...newItem, cartItemKey: key });
      }
    }
    
    // Save merged cart
    await redis.set(cartKey, JSON.stringify(existingCart), { ex: 3600 });
    
    // Use merged cart for display
    cart = existingCart;
    
    // Show cart summary and ask if they want more items (using askForMoreItems format)
    const total = cart.reduce((s, i) => s + i.price * i.quantity, 0);
    
    let message = `تم استلام طلبك! ✅\n\n`;
    message += `📦 *طلبك حتى الآن:*\n\n`;
    cart.forEach((item, i) => {
      message += `  ${i + 1}. *${item.name}*${item.variantInfo ? ` _(${item.variantInfo})_` : ''}`;
      message += ` — ${item.quantity} حبة × ${item.price} = *${item.price * item.quantity} جنيه*\n`;
    });
    message += `\n💰 *الإجمالي: ${total} جنيه*\n\n`;
    message += `عايز تضيف حاجة تانية؟ 😊\n\n`;
    message += `✅ *نعم* — أضيف كمان\n`;
    message += `🚀 *لا* — خلّص الطلب وابعته`;
    
    await sock.sendMessage(from, { text: message });
    
    // Set state to waiting_for_more (same as askForMoreItems)
    const stateKey = `order_state:${shop.id}:${customerPhone}`;
    await redis.set(stateKey, 'waiting_for_more', { ex: 600 });
    
    console.log(`✅ Website order processed for ${customerPhone}, ${cart.length} items, ${total} EGP`);
  }

  // Validate AI response
  validateAIResponse(response) {
    if (!response || response.length < 5) {
      return 'عذراً، لم أفهم طلبك. يرجى كتابة "قائمة" لعرض المنتجات.';
    }
    if (response.length > 500) {
      return response.substring(0, 497) + '...';
    }
    return response;
  }

  // Smart response handler with emotional intelligence and Groq AI - ENHANCED
  async handleSmartResponse(sock, from, shop, customerPhone, text, context) {
    // ALWAYS try AI first for natural conversation (unless it's a clear command)
    const lowerText = text.toLowerCase();
    
    // Check if this is a clear command that should NOT use AI
    const clearCommands = ['قائمة', 'منيو', 'menu', 'كارت', 'سلة', 'cart', 'اطلب', 'order', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10'];
    const isClearCommand = clearCommands.some(cmd => lowerText === cmd || lowerText.startsWith(cmd + ' '));
    
    // If it's a clear command, use rule-based response
    if (isClearCommand && !context.isReturningCustomer) {
      return this.handleRuleBasedResponse(sock, from, shop, customerPhone, text, context);
    }
    
    // Check for duplicate help messages
    const lastResponseKey = `last:${shop.id}:${customerPhone}`;
    const lastResponse = await redis.get(lastResponseKey);
    const lastResponseType = await redis.get(`${lastResponseKey}:type`);
    
    // Detect emotion and intent
    const emotion = this.detectEmotion(text);
    const intent = this.detectAdvancedIntent(text);
    
    // Try Groq AI first for natural conversation
    let groqResponse = await this.getGroqResponse(text, shop, context, emotion, intent, customerPhone, lastResponse);
    
    if (groqResponse) {
      // Validate AI response
      groqResponse = this.validateAIResponse(groqResponse);
      
      await this.safeSendMessage(sock, from, groqResponse, shop.name);
      await this.updateMessageHistory(shop.id, customerPhone, text, 'user', intent);
      await this.updateMessageHistory(shop.id, customerPhone, groqResponse, 'bot', 'groq_response');
      await redis.set(lastResponseKey, groqResponse, { ex: 300 });
      await redis.set(`${lastResponseKey}:type`, 'ai', { ex: 300 });
      return;
    }
    
    // Fallback to rule-based response
    return this.handleRuleBasedResponse(sock, from, shop, customerPhone, text, context);
  }

  // Rule-based fallback responses
  async handleRuleBasedResponse(sock, from, shop, customerPhone, text, context) {
    const lastResponseKey = `last:${shop.id}:${customerPhone}`;
    const lastResponseType = await redis.get(`${lastResponseKey}:type`);
    
    // Detect emotion and intent
    const emotion = this.detectEmotion(text);
    const intent = this.detectAdvancedIntent(text);
    
    // If last response was help and this is unknown message again, use AI instead
    if (lastResponseType === 'help') {
      const fallbackAI = 'عذراً، لم أفهم طلبك. يرجى كتابة "قائمة" لعرض المنتجات أو "مساعدة" للحصول على المساعدة.';
      await this.safeSendMessage(sock, from, fallbackAI, shop.name);
      await this.updateMessageHistory(shop.id, customerPhone, fallbackAI, 'bot', 'fallback');
      await redis.set(lastResponseKey, fallbackAI, { ex: 300 });
      await redis.set(`${lastResponseKey}:type`, 'ai', { ex: 300 });
      return;
    }
    
    // Fallback to rule-based human-like response
    const response = await this.getHumanLikeResponse(text, shop, context, emotion, intent);
    
    await this.safeSendMessage(sock, from, response, shop.name);
    await this.updateMessageHistory(shop.id, customerPhone, text, 'user', intent);
    await this.updateMessageHistory(shop.id, customerPhone, response, 'bot', 'response');
    await redis.set(lastResponseKey, response, { ex: 300 });
    await redis.set(`${lastResponseKey}:type`, 'help', { ex: 300 });
  }

  // Groq AI integration for smart natural responses
  async getGroqResponse(text, shop, context, emotion, intent, customerPhone, lastResponse = '') {
    if (!groq) {
      console.log('⚠️ Groq not configured, skipping AI response');
      return null;
    }

    try {
      // Get conversation history for context
      const historyKey = `chat_history:${shop.id}:${customerPhone}`;
      const historyData = await redis.get(historyKey);
      let messages = [];
      
      if (historyData) {
        try {
          if (typeof historyData === 'string') {
            messages = JSON.parse(historyData);
          } else if (typeof historyData === 'object') {
            messages = historyData;
          }
        } catch (e) {
          messages = [];
        }
      }
      
      // Build conversation context for Groq
      const conversationHistory = messages.slice(-5).map(m => ({
        role: m.sender === 'user' ? 'user' : 'assistant',
        content: m.text
      }));

      // Get cart data for context
      const cartKey = `cart:${shop.id}:${customerPhone}`;
      const cartData = await redis.get(cartKey);
      let cart = [];
      if (cartData) {
        try {
          cart = typeof cartData === 'string' ? JSON.parse(cartData) : cartData;
        } catch (e) { cart = []; }
      }
      
      const contextMessage = cart.length > 0 
        ? `العميل لديه ${cart.length} منتج في السلة` 
        : `سلة العميل فارغة`;

      // Create system prompt with shop context - STRICT FORMAL ARABIC ONLY
      const systemPrompt = `أنت موظف خدمة عملاء اسمك *ذكي* تعمل في متجر "${shop.name}".

هويتك:
- اسمك: ذكي
- وظيفتك: موظف خدمة عملاء محترف
- إذا سألك العميل عن اسمك قل: "أنا ذكي، موظف خدمة العملاء"
- إذا سألك من أنت قل: "أنا ذكي، موظف خدمة العملاء في ${shop.name}"
- لا تقل أبداً أنك بوت أو روبوت أو ذكاء اصطناعي

قواعد اللغة - صارمة جداً:
1. استخدم اللغة العربية الفصحى الرسمية فقط
2. ممنوع منعاً باتاً: أيوه، لأ، تمام، ماشي، كويس،
   عامل، ازيك، يلا، بص، معلش، خلاص، زي، أوي،
   دلوقتي، عايز، مش، إيه، فين، ازاي، بقى، كمان
3. الكلمات الصحيحة: نعم، لا، حسناً، الآن، تريد،
   ليس، ما، أين، كيف، أيضاً، عفواً
4. لا أخطاء إملائية أبداً
5. ردودك قصيرة ومختصرة لا تتجاوز 3 جمل
6. كن محترفاً ومهذباً في جميع الأوقات
7. لا تكرر نفس الرد مرتين
8. تذكر دائماً أنك تمثل صورة المتجر

المنتجات المتاحة: ${shop.products?.filter(p => p.isAvailable).map(p => `${p.name} (${p.price} جنيه)`).join(', ') || 'منتجات متنوعة'}

${contextMessage}

معلومات العميل:
الاسم: ${context.name || 'غير معروف'}
السلة: ${context.hasItems ? `${context.itemCount} منتج (${context.totalValue} جنيه)` : 'فارغة'}

تعليمات إضافية:
- إذا سأل العميل "كيف أطلب" أو "طريقة الطلب"، اشرح: اكتب قائمة ثم اختر رقم المنتج ثم اكتب اطلب
- إذا شكا العميل من مشكلة، اعتذر بلطف واقترح التواصل مع صاحب المحل
- كن إيجابياً ومحفزاً دائماً`;

      // Prepare messages for Groq
      const groqMessages = [
        { role: 'system', content: systemPrompt },
        ...conversationHistory,
        { role: 'user', content: text }
      ];

      console.log('🤖 Sending to Groq:', text.slice(0, 50) + '...');

      const chatCompletion = await groq.chat.completions.create({
        messages: groqMessages,
        model: 'llama-3.3-70b-versatile',
        temperature: 0.9, // Increased for more creative and friendly responses
        max_tokens: 200, // Increased for longer helpful responses
        top_p: 0.95, // Slightly higher for more natural responses
        stream: false
      });

      const aiResponse = chatCompletion.choices[0]?.message?.content?.trim();
      
      if (aiResponse) {
        console.log('✅ Groq response received:', aiResponse.slice(0, 50) + '...');
        return aiResponse;
      }
      
      return null;
    } catch (error) {
      console.error('❌ Groq error:', error.message);
      return null;
    }
  }

  // Detect user emotion with spelling tolerance - ENHANCED for frustration
  detectEmotion(text) {
    const normalizedText = ' ' + this.normalizeText(text) + ' '; // Add spaces for word boundary detection
    const emotions = {
      frustrated: [
        'مش شغال', 'خراب', 'زهق', 'عصب', 'غضبان', 'متضايق', 
        'مش فاهم', 'مش بيشتغل', 'وحش', 'سيئ', 'باظ', 'تعبت', 'زهقت',
        'ليه كدا', 'معقول', 'مش تمام',
        'مش شايف', 'مخنوق', 'مستفز', 'زفت',
        'مش ماشي', 'قرفت', 'مش فاهمة', 'ايه الغباء', 'غلط', 'غلطان',
        'ياعم', 'يا عم', 'انت فاشل'
      ],
      excited: ['عظمة', 'جيد', 'ممتاز', 'جميل', 'رائع', 'لذيذ', ' perfect', 'awesome', 'great', 'حلو', 'شهي', 'ممتاز جدا'],
      confused: [
        'لا أفهم', 'كيف ذلك', 'ماذا تقصد', 'لا أعرف', 'صعب', 'معقد', 'مش عارف', 
        'مش فاهم', 'في إيه', 'ازاي', 'يعني', 'هو إيه', 'شرح', 'افسر'
      ],
      urgent: ['بسرعة', 'عاجل', 'الآن', 'urgent', 'بسرعة', 'على السريع', 'بسرعه', 'عاجل جدا'],
      happy: ['شكرا', 'تسلم', 'دومت', '❤️', '😍', '😊', '🥰', 'حبيت', 'عجبني', 'شكر', 'مشكور'],
    };
    
    for (const [emotion, keywords] of Object.entries(emotions)) {
      // Use word boundary matching - don't match short words as substrings
      if (keywords.some(k => {
        // For very short keywords (<= 3 chars), require exact match with spaces
        if (k.length <= 3) {
          return normalizedText.includes(' ' + k + ' ');
        }
        return this.fuzzyMatch(normalizedText, k, 0.8);
      })) return emotion;
    }
    return 'neutral';
  }

  // Advanced intent detection with spelling tolerance
  detectAdvancedIntent(text) {
    const normalizedText = this.normalizeText(text);
    
    const intents = {
      complaint: ['سيئ', 'خراب', 'لا يعمل', 'رديء', 'ليس لذيذ', 'بارد', 'سخن', 'سيء', 'تأخير'],
      compliment: ['حلو', 'جميل', 'عظمة', 'ممتاز', 'رائع', 'لذيذ', 'طعمه حلو', ' perfect', 'good'],
      question_product: ['عندك', 'فيه', 'موجود', 'متاح', 'عندكم', 'ايش عندك'],
      question_price: ['بكام', 'سعر', 'cost', 'فلوس', 'قيمة', 'تكلفة', 'بكم'],
      question_time: ['امتى', 'متى', 'ساعة', 'وقت', 'دقيقة', 'امتا', 'توصيل'],
      small_talk: ['كيف حالك', 'أخبارك', 'كيفك', 'صباح', 'مساء', 'نهارك', 'فطور', 'غدا', 'عشاء', 'طعامك', 'أخبار'],
    };
    
    for (const [intent, keywords] of Object.entries(intents)) {
      if (keywords.some(k => this.fuzzyMatch(normalizedText, k, 0.8))) return intent;
    }
    return 'general';
  }

  // Human-like smart response with personality
  async getHumanLikeResponse(text, shop, context, emotion, intent) {
    const lowerText = text.toLowerCase();
    const name = context.name ? `يا ${context.name}` : 'يا فندم';
    
    // Emotional response adjustments - FORMAL ARABIC ONLY
    const emotionalPrefix = {
      frustrated: `🤗 ${name}، أفهم أنك غاضب... دعني أساعدك:`,
      confused: `💡 ${name}، الأمر سهل جداً! دعني أوضح لك:`,
      urgent: `⚡ ${name}، سأتصرف معك فوراً:`,
      excited: `🎉 ${name}، أراك متحمساً!`,
      happy: `😊 ${name}، دائماً في خدمتك!`,
      neutral: ''
    };
    
    const prefix = emotionalPrefix[emotion] || '';
    
    // Context-aware greeting for returning customers
    const greeting = context.isReturningCustomer && context.messageCount > 5
      ? `${name}، نورتنا مجدداً! 🌟\n\n`
      : context.messageCount === 1
        ? `أهلاً وسهلاً! 👋 مرحباً بك في *${shop.name}*\n\n` +
          `🤖 *أنا مساعدك الذكي*\n` +
          `أفهم أوامرك وأساعدك في الطلب بسرعة وسهولة.\n\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `📖 *كيفية الاستخدام:*\n\n` +
          `📋 اكتب *قائمة*\n` +
          `    ← لعرض جميع المنتجات والأسعار\n\n` +
          `🔢 اكتب *رقم المنتج* (مثال: 1 أو 2)\n` +
          `    ← لإضافة المنتج إلى سلتك\n\n` +
          `🛒 اكتب *كارت*\n` +
          `    ← لعرض ما في سلتك\n\n` +
          `✅ اكتب *اطلب*\n` +
          `    ← لتأكيد طلبك\n\n` +
          `❌ اكتب *إلغاء*\n` +
          `    ← لمسح السلة والبدء من جديد\n\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `ابدأ الآن بكتابة *قائمة* 👇`
        : '';

    // Advanced intent responses with personality
    const responses = {
      greeting: this.getGreetingResponse(name, shop, context),
      complaint: this.getComplaintResponse(name, shop),
      compliment: this.getComplimentResponse(name, shop),
      question_product: this.getProductQuestionResponse(name, shop),
      question_price: this.getPriceQuestionResponse(name, shop),
      question_time: this.getTimeQuestionResponse(name, shop),
      small_talk: this.getSmallTalkResponse(name, shop, context),
      joke: this.getJokeResponse(name),
      help: this.getHelpResponse(name, shop, context),
    };
    
    // Check for specific intents first
    for (const [key, responseFunc] of Object.entries(responses)) {
      if (this.matchesIntent(lowerText, key)) {
        const response = await responseFunc;
        return prefix ? `${prefix}\n\n${response}` : response;
      }
    }
    
    // Smart fallback with context
    return this.getSmartFallback(name, shop, context, greeting);
  }

  // Normalize Arabic text for better matching (handle common variations)
  normalizeText(text) {
    return text
      .toLowerCase()
      .trim()
      // Arabic letter variations
      .replace(/[أإآا]/g, 'ا')    // All forms of alef
      .replace(/ى/g, 'ي')         // Alef maksura to ya
      .replace(/ة/g, 'ه')         // Ta marbuta to ha
      .replace(/[ؤئ]/g, 'ء')      // Hamza variations
      // Remove extra spaces and punctuation
      .replace(/\s+/g, ' ')
      .replace(/[.,!?;:\-_]/g, '');
  }

  // Calculate string similarity (Levenshtein distance based)
  calculateSimilarity(str1, str2) {
    const len1 = str1.length;
    const len2 = str2.length;
    const matrix = [];

    for (let i = 0; i <= len1; i++) {
      matrix[i] = [i];
    }
    for (let j = 0; j <= len2; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= len1; i++) {
      for (let j = 1; j <= len2; j++) {
        const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1,      // deletion
          matrix[i][j - 1] + 1,      // insertion
          matrix[i - 1][j - 1] + cost // substitution
        );
      }
    }

    const distance = matrix[len1][len2];
    const maxLen = Math.max(len1, len2);
    return maxLen === 0 ? 1 : 1 - distance / maxLen;
  }

  // Fuzzy match with spelling tolerance (tightened to prevent false positives)
  fuzzyMatch(text, pattern, threshold = 0.7) {
    const normalizedText = this.normalizeText(text);
    const normalizedPattern = this.normalizeText(pattern);
    
    // Exact full match
    if (normalizedText === normalizedPattern) return true;
    
    // Full pattern found as substring in text
    if (normalizedText.includes(normalizedPattern)) return true;
    
    const textWords = normalizedText.split(' ').filter(w => w.length > 0);
    const patternWords = normalizedPattern.split(' ').filter(w => w.length > 0);
    
    // Helper: check if a single pattern word matches any text word
    const wordMatches = (pw) => {
      return textWords.some(tw => {
        // Text word contains pattern word (pattern must be ≥3 chars to avoid "بس" matching inside longer words)
        if (pw.length >= 3 && tw.includes(pw)) return true;
        // Exact match for short words (2 chars)
        if (pw.length === 2 && tw === pw) return true;
        // Similarity check only for similar-length words (diff ≤ 1)
        if (Math.abs(tw.length - pw.length) <= 1 && tw.length >= 3) {
          return this.calculateSimilarity(tw, pw) >= threshold;
        }
        return false;
      });
    };
    
    // Multi-word patterns: ALL significant words (≥3 chars) must match
    if (patternWords.length > 1) {
      const significantWords = patternWords.filter(w => w.length >= 3);
      if (significantWords.length === 0) return false;
      return significantWords.every(pw => wordMatches(pw));
    }
    
    // Single-word pattern
    return wordMatches(patternWords[0]);
  }

  // Enhanced matchesIntent with spelling mistake tolerance
  matchesIntent(text, intent) {
    const patterns = {
      greeting: [
        'مرحبا', 'سلام', 'اهلا', 'هلا', 'صباح', 'مساء', 'هاي', 'hello', 'hi', 
        'السلام', 'كيف حالك', 'أخبارك', 'حياك', 'أهلين', 'هلا والله', 'عامل ايه', 'ازيك', 'إيه الأخبار', 'الأخبار إيه',
        'يا باشا', 'يا معلم', 'يا كبير', 'يا ريس', 'تصبح على خير', 'يسعد صباحك', 'يسعد مساك',
        'نورت', 'نورتنا', 'السلام عليكم', 'وعليكم السلام',
        // Common misspellings
        'مرحب', 'مرحب', 'اهلان', 'اهلين', 'هلاا', 'سلامم', 'مرحباً', 'عامل', 'كيفك', 'ازيك', 'الاخبار', 'كيف الحال'
      ],
      complaint: [
        'مش كويس', 'سيئ', 'خراب', 'مش شغال', 'رديء', 'مش لذيذ', 'بارد', 'سخن', 
        'تأخير', 'بطئ', 'مش حلو', 'وحش', 'سيء',
        // Misspellings
        'مش شغل', 'مش شغاله', 'خرابه', 'سئ', 'سىء', 'بطيء', 'بطىء'
      ],
      compliment: [
        'حلو', 'جميل', 'عظمة', 'ممتاز', 'رائع', 'لذيذ', 'طعمه حلو', 'احسن', 'افضل',
        'perfect', 'good', 'nice', 'great', 'awesome',
        // Misspellings
        'حلوو', 'حلاوة', 'جمال', 'عظمه', 'ممتازز', 'رائعع', 'لذيذذ'
      ],
      question_product: [
        'عندك', 'فيه', 'موجود', 'متاح', 'شو عندك', 'ايش', 'عندكم', 'ايه عندك',
        // Misspellings
        'عندكك', 'عندكك', 'فيهه', 'موجودد', 'متاحح'
      ],
      question_price: [
        'بكام', 'سعر', 'cost', 'فلوس', 'قيمة', 'تكلفة', 'كم', 'بكم', 'كام',
        // Misspellings
        'بكامم', 'سععر', 'فلوسص', 'كما', 'بكام'
      ],
      question_time: [
        'امتى', 'متى', 'ساعة', 'وقت', 'دقيقة', 'delivery', 'توصيل', 'امتى',
        // Misspellings
        'امتىى', 'امتا', 'امتى', 'ساعه', 'دقيقه', 'توقيت'
      ],
      small_talk: [
        'كيف حالك', 'أخبارك', 'كيفك', 'صباح', 'مساء', 'نهارك', 
        'فطور', 'غدا', 'عشاء', 'طعامك', 'أخبار', 'ما الأخبار',
        // Misspellings
        'أخبارر', 'أخباركك', 'كيففك', 'صباحح', 'كيف الحال'
      ],
      joke: [
        'نكتة', 'نكته', 'joke', 'ضحك', 'هظحك', 'فرفش', 'نكت', 'تحشيش', 'هبل',
        // Misspellings
        'نكتت', 'نكتةة', 'ضحكك', 'فرفشش'
      ],
      help: [
        'مساعدة', 'help', 'ازاي', 'كيف', 'شلون', 'كيفية', 'طريقة', 'شرح',
        // Misspellings
        'مساعده', 'مساعدةة', 'ازايي', 'كيفف', 'شلونن'
      ],
      menu: [
        'قائمة', 'منيو', 'menu', 'قايمة', 'قائمه', 'القائمة', 'المنيو',
        'ورني الحاجات', 'ورني المنتجات', 'عرض المنتجات', 'عايز اشوف المنتجات',
        'المنتجات', 'منتجات', 'ايه اللي عندكم', 'ورني',
        // Misspellings
        'قايمه', 'قائمةة', 'منيوو', 'قايمةة', 'قائمه'
      ],
      cart: [
        'كارت', 'cart', 'سلة', 'السلة', 'الكارت', 'عربية', 'عربيه',
        // Misspellings
        'كاررت', 'كارتت', 'سله', 'سلةة'
      ],
      order: [
        'اطلب', 'order', 'اطلب', 'احجز', 'booking', 'حجز',
        // Misspellings
        'اطلبب', 'اطللب', 'احجزز', 'حجزز'
      ],
      yes: [
        'نعم', 'ايوه', 'yes', 'أيوه', 'أيوة', 'ايوة', 'اوكي', 'حسنا', 'حسناً', 'ok', 'okay',
        'اه', 'أه', 'ايوا', 'اا', 'اة', 'يب', 'طبعا', 'طبعاً', 'بالظبط', 'اكيد',
        // Misspellings
        'نعما', 'ايووه', 'ايوهه', 'أيووه', 'اوكيي', 'حسناا', 'ايواا', 'اهه'
      ],
      no: [
        'لا', 'no', 'لأ', 'لأ', 'ليس', 'لا أريد', 'لا أحب',
        'مش عايز', 'مش عايزه', 'مش عايزة',
        // Misspellings
        'لأأ', 'لاا', 'ليسس'
      ],
      cancel: [
        'الغاء', 'cancel', 'stop', 'لا أريد', 'غير', 'ما أريد', 'لا أحب',
        'الفاء', 'إلغاء', 'الغي', 'إلغي', 'امسح الكل', 'اوقف', 'إيقاف', 'مسح الكل', 'صفر السلة',
        'بلاش', 'مش عايز حاجه', 'مش عايز حاجة', 'مش عايزه حاجه',
        // Misspellings
        'الغا', 'الغاءء', 'كانسل', 'cancle', 'الغيي', 'الغاء الطلب', 'إلغاء الطلب', 'الغي الطلب', 'امسح السلة', 'بلاشش'
      ],
      done: [
        'خلاص', 'بس', 'كده', 'بس كده', 'خلاص كده', 'كفاية', 'تم', 'مش عايز حاجة تاني',
        'هو ده', 'ده بس', 'كده تمام', 'بس يا معلم', 'بس خلاص', 'مش عايز تاني',
        'done', 'that is all', 'thats all', 'finish', 'enough',
        // Misspellings
        'خلاصص', 'بسس', 'كدا', 'كدة', 'بس كدا', 'خلص', 'خلصت', 'كفايه', 'بسس كده'
      ],
      thanks: [
        'شكرا', 'thank', 'merci', 'تسلم', 'دومت', 'شكر', 'شكراً', 'thanks', 'thx',
        'مشكور', 'جزاك الله', 'بارك الله',
        // Misspellings
        'شكرر', 'شكراا', 'شكرراً', 'تسلمم'
      ],
      order_status: [
        'فين طلبي', 'فين الطلب', 'الطلب وصل فين', 'الاوردر فين', 'حالة الطلب', 'حالة طلبي',
        'وصل فين', 'الطلب ايه اخباره', 'اخبار الطلب', 'track', 'status', 'طلبي فين',
        'الاوردر', 'متى يوصل', 'هيوصل امتى', 'امتى هيوصل',
        // Misspellings
        'فين طلبى', 'حاله الطلب', 'اخبار طلبي'
      ],
      delivery: [
        'التوصيل', 'بتوصلوا', 'مصاريف التوصيل', 'سعر التوصيل', 'التوصيل بكام',
        'بتوصلوا فين', 'بتوصلوا لحد فين', 'مناطق التوصيل', 'اماكن التوصيل',
        'الشحن', 'مصاريف الشحن', 'الدليفري', 'delivery', 'shipping',
        'توصيل لحد البيت', 'توصيل مجاني', 'في توصيل',
        'بيوصل', 'هيوصل', 'يوصل', 'هيجي', 'هيجيلي', 'بيجي',
        'بيوصل في قد ايه', 'هيوصل في قد ايه', 'كام يوم', 'خلال كام يوم',
        'بيوصل في كام يوم', 'الاوردر بيوصل', 'الطلب بيوصل',
        'الاوردر هيجيلي', 'الطلب هيجيلي', 'امتى يوصل', 'امتى هيوصل',
        // Misspellings
        'التوصييل', 'بتوصلو', 'الدليفرى', 'دليفري', 'هيوصلل', 'بيوصلل'
      ],
      address: [
        'عنوان', 'address', 'موقع', 'مكان', 'loc',
        // Misspellings
        'عنوانن', 'عنوان', 'عنواان'
      ],
      discount: [
        'عرض', 'خصم', 'تخفيض', 'discount', 'offer', 'sale', 'في عرض', 'في خصم',
        'عروض', 'خصومات', 'تخفيضات', 'بروموشن', 'promo', 'كوبون', 'coupon', 'كود خصم',
        'في اوفر', 'خصم خاص', 'سعر خاص', 'ارخص', 'أرخص',
        // Misspellings
        'عروضض', 'خصمم', 'تخفيضض', 'بروموشون'
      ],
      payment: [
        'الدفع', 'كاش', 'فيزا', 'visa', 'cash', 'فودافون كاش', 'اتصالات كاش', 'فوري',
        'طريقة الدفع', 'طرق الدفع', 'بتقبلوا', 'بدفع ازاي', 'ادفع ازاي', 'ادفع إزاي',
        'instapay', 'انستاباي', 'محفظة', 'تحويل', 'فلوس', 'payment',
        // Misspellings
        'الدفعع', 'كاشش', 'فيزاا', 'فودافوون'
      ],
      working_hours: [
        'مواعيد', 'مواعيد العمل', 'بتفتحوا', 'بتقفلوا', 'شغالين', 'شغالين لحد امتى',
        'ساعات العمل', 'مفتوح', 'مقفول', 'فاتح', 'بتشتغلوا', 'بتشتغلوا لحد امتى',
        'امتى بتفتحوا', 'مواعيدكم', 'مفتوح دلوقتي', 'شغالين دلوقتي',
        'working hours', 'open', 'closed', 'hours',
        // Misspellings
        'مواعييد', 'بتفتحو', 'بتقفلو', 'بتشتغلو', 'شغالييين'
      ],
      location: [
        'فين المحل', 'فين المكان', 'عنوان المحل', 'العنوان', 'الموقع', 'فرع', 'فروع',
        'عندكم فرع', 'location', 'where', 'لوكيشن', 'خريطة', 'map',
        'فين بالظبط', 'المكان فين', 'ازاي اوصل', 'ازاي أوصل', 'اروح ازاي',
        // Misspellings
        'فيين', 'المحلل', 'عنواان', 'لوكيشون', 'فرووع'
      ],
      return_policy: [
        'ارجاع', 'إرجاع', 'استبدال', 'ينفع أرجع', 'ينفع ارجع', 'استرجاع', 'الاسترجاع',
        'لو مش عاجبني', 'لو مش مناسب', 'ضمان', 'warranty', 'return', 'refund',
        'لو فيه مشكلة', 'تبديل', 'ينفع ابدل', 'لو الحاجة مش كويسة',
        // Misspellings
        'ارجااع', 'استبداال', 'ضماان', 'تبديييل'
      ],
      recommend: [
        'نصحني', 'ايه أحسن', 'ايه احسن', 'ايه أكتر حاجة', 'الأكثر مبيعا', 'بيست سيلر',
        'اختارلي', 'مش عارف اختار', 'مش عارفة أختار', 'ترشحلي', 'ايه الحلو',
        'best seller', 'recommend', 'مقترحات', 'اقتراح', 'ايه الأحسن',
        'حاجة حلوة', 'ابعتلي حاجة حلوة', 'عايز حاجة حلوة', 'انصحني',
        // Misspellings
        'نصحنى', 'اختارلى', 'ترشحلى', 'اقتراحح', 'مقترحاات'
      ],
      store_link: [
        'لينك', 'رابط', 'link', 'url', 'الموقع', 'المتجر', 'رابط المتجر', 'لينك المتجر',
        'ابعتلي اللينك', 'ابعتلي الرابط', 'عايز اللينك', 'عايز الرابط',
        // Misspellings
        'لينكك', 'رابطط', 'المتجرر'
      ],
      talk_to_human: [
        'كلم المدير', 'عايز أكلم حد', 'عايز اكلم حد', 'كلم حد', 'بشر', 'إنسان',
        'عايز ادم', 'مش بوت', 'agent', 'human', 'عايز صاحب المحل', 'صاحب المحل',
        'ممكن اكلم صاحب الشغل', 'عايز اتكلم مع حد',
        // Misspellings
        'كلمم', 'المديرر', 'بشرر'
      ],
      affirmative: [
        'طب', 'ماشي', 'تمام', 'اوكي', 'حاضر', 'أكيد', 'اكيد', 'ok', 'okay',
        'ان شاء الله', 'إن شاء الله', 'خلاص تمام', 'طيب', 'good', 'أوك',
        // Misspellings
        'طبب', 'ماشيي', 'تمامم', 'حاضرر', 'طييب'
      ],
      whats_new: [
        'ايه الجديد', 'جديد', 'new', 'وصل حاجة جديدة', 'في جديد', 'حاجة جديدة',
        'منتجات جديدة', 'أحدث', 'latest', 'ايه اللي نزل',
        // Misspellings
        'الجدييد', 'جديدد', 'أحدثث'
      ],
    };
    
    const intentPatterns = patterns[intent];
    if (!intentPatterns) return false;
    
    // Try fuzzy matching with tolerance for spelling mistakes
    // For 'yes' and 'no' intents, require exact match (not partial) to avoid false positives
    if (intent === 'yes' || intent === 'no') {
      // Require exact match or standalone word for yes/no
      return intentPatterns.some(p => {
        const normalizedText = ' ' + this.normalizeText(text) + ' ';
        const normalizedPattern = ' ' + this.normalizeText(p) + ' ';
        return normalizedText === normalizedPattern || 
               normalizedText.includes(normalizedPattern);
      });
    }
    return intentPatterns.some(p => this.fuzzyMatch(text, p, 0.75));
  }

  async getGreetingResponse(name, shop, context) {
    const hour = new Date().getHours();
    let timeGreeting = '';
    
    if (hour >= 5 && hour < 12) timeGreeting = 'صباح الخير ☀️';
    else if (hour >= 12 && hour < 17) timeGreeting = 'مساء النور 🌤️';
    else if (hour >= 17 && hour < 21) timeGreeting = 'مساء الخير 🌆';
    else timeGreeting = 'تصبح على خير 🌙';
    
    if (context.hasItems) {
      return `${timeGreeting} ${name}! 😊\n\n` +
             `أرى أنك اخترت ${context.itemCount} منتجات (${context.totalValue} جنيه)\n` +
             `اكتب "كارت" لعرض تفاصيل طلبك 🛒`;
    }
    
    return `${timeGreeting} ${name}! 🌟\n\n` +
           `أهلاً بك في ${shop.name}! \n` +
           `هل ترغب في رؤية منتجاتنا؟ اكتب "قائمة" 📋`;
  }

  async getComplaintResponse(name, shop) {
    return `🙏 نعتذر إليك ${name} إذا كانت هناك أي مشكلة...\n\n` +
           `نحن هنا لحلها فوراً! \n` +
           `هل يمكنك التواصل مع صاحب المحل مباشرة على الهاتف؟ 📞\n\n` +
           `أو اكتب "قائمة" لعرض المنتجات المتاحة`;
  }

  async getComplimentResponse(name, shop) {
    const thanks = ['شكراً جزيلاً!', 'نقدر كلامك الطيب!', 'بارك الله فيك!', 'دائماً في خدمتك!'];
    const randomThanks = thanks[Math.floor(Math.random() * thanks.length)];
    
    return `🥰 ${randomThanks} ${name}!\n\n` +
           `شرفت ${shop.name}! \n` +
           `إذا كنت بحاجة لأي شيء آخر، أنا في خدمتك 😊`;
  }

  async getProductQuestionResponse(name, shop) {
    return `📦 ${name}، لدينا تشكيلة ممتازة من المنتجات!\n\n` +
           `اكتب "قائمة" لرؤية جميع المنتجات واختر ما يناسبك 👌`;
  }

  async getPriceQuestionResponse(name, shop) {
    return `💰 ${name}، أسعارنا تنافسية وجودتنا ممتازة!\n\n` +
           `اكتب "قائمة" لرؤية الأسعار مع كل منتج 📋`;
  }

  async getTimeQuestionResponse(name, shop) {
    return `⏰ ${name}، نوصل الطلبات في أسرع وقت ممكن!\n\n` +
           `عادةً ما يستغرق التوصيل من 30-60 دقيقة حسب الموقع\n` +
           `اكتب "اطلب" وابدأ طلبك الآن! 🚀`;
  }

  async getSmallTalkResponse(name, shop, context) {
    const hour = new Date().getHours();
    let mealSuggestion = '';
    
    if (hour >= 7 && hour < 11) mealSuggestion = 'لدينا إفطار شهي! 🥐';
    else if (hour >= 11 && hour < 16) mealSuggestion = 'جاهزون لغداء ممتاز! 🍽️';
    else if (hour >= 16 && hour < 22) mealSuggestion = 'عشاء شهي بانتظارك! 🍲';
    
    return `😊 ${name}، الحمد لله بخير!\n\n` +
           (mealSuggestion ? `${mealSuggestion}\n` : '') +
           `اكتب "قائمة" إذا كنت ترغب في رؤية المنتجات المتاحة 🍽️`;
  }

  async getJokeResponse(name) {
    const jokes = [
      `😂 ${name}، لماذا أحببت البيضة الجيم؟ لأنها تحب تحطيم البطن!`,
      `🤣 ${name}، لماذا لا تستخدم السمكة الكمبيوتر؟ لأنها تخشى من الشبكة!`,
      `😅 ${name}، اثنان فطر يتحدثان، قال أحدهما للآخر: أنت لذيذ الطعم، فقال له: لا، أنت تضحكني!`,
    ];
    return jokes[Math.floor(Math.random() * jokes.length)] + '\n\nاكتب "قائمة" للعودة للعمل 😂📋';
  }

  async getHelpResponse(name, shop, context) {
    let personalizedHelp = '';
    
    if (context.hasItems) {
      personalizedHelp = `💡 لديك ${context.itemCount} منتج في السلة!\n` +
                        `اكتب "كارت" لعرضهم أو "اطلب" للتأكيد\n\n`;
    }
    
    return `👋 ${name}، أنا هنا للمساعدة!\n\n` +
           personalizedHelp +
           `📋 "قائمة" - عرض المنتجات\n` +
           `🛒 "كارت" - عرض طلبك\n` +
           `✅ "اطلب" - تأكيد الطلب\n` +
           `💡 اكتب رقم المنتج مباشرة (1, 2, 3...)`;
  }

  async getSmartFallback(name, shop, context, greeting) {
    // Smart suggestions based on context
    let suggestion = '';
    
    if (context.hasItems) {
      suggestion = `💡 اكتب "كارت" لعرض طلبك (${context.totalValue} جنيه) أو "اطلب" لتأكيد ✅`;
    } else if (context.messageCount > 3) {
      suggestion = `💡 اكتب "قائمة" لعرض المنتجات المتاحة 📋`;
    } else {
      suggestion = `💡 يمكنك كتابة "قائمة" أو "مساعدة" لمعرفة الأوامر`;
    }
    
    const confusedResponses = [
      `🤔 ${name}، لم أفهم جيداً...`,
      `😅 ${name}، هل يمكنك التوضيح أكثر؟`,
      `💭 ${name}، عذراً، لم أتمكن من الفهم`,
    ];
    
    const randomConfused = confusedResponses[Math.floor(Math.random() * confusedResponses.length)];
    
    return greeting + randomConfused + '\n\n' + suggestion;
  }

  // Keep the original methods but enhanced
  async getAIResponse(text, shop) {
    // This is now replaced by getHumanLikeResponse
    return this.getSmartResponse(text, shop);
  }

  getSmartResponse(text, shop) {
    // Legacy method - kept for compatibility
    return null;
  }

  async askForMoreItems(sock, from, shopId, customerPhone, shop) {
    try {
      const cartKey = `cart:${shopId}:${customerPhone}`;
      let cart = await redis.get(cartKey);
      
      let items = [];
      if (cart) {
        try {
          if (typeof cart === 'string') {
            items = JSON.parse(cart);
          } else if (typeof cart === 'object') {
            items = cart;
          }
        } catch (e) {
          items = [];
        }
      }

      if (items.length === 0) {
        await this.safeSendMessage(sock, from, "السلة فارغة! 😅\n\nاكتب \"قائمة\" أولاً واختر منتجاً.", shop.name);
        return;
      }

      const total = items.reduce((sum, i) => sum + i.price * i.quantity, 0);
      
      let message = `📦 *طلبك حتى الآن:*\n\n`;
      items.forEach((item, i) => {
        message += `  ${i + 1}. *${item.name}*${item.variantInfo ? ` _(${item.variantInfo})_` : ''}`;
        message += ` — ${item.quantity} حبة × ${item.price} = *${item.price * item.quantity} جنيه*\n`;
      });
      message += `\n💰 *الإجمالي: ${total} جنيه*\n\n`;
      message += `عايز تضيف حاجة تانية؟ 😊\n\n`;
      message += `✅ *نعم* — أضيف كمان\n`;
      message += `🚀 *لا* — خلّص الطلب وابعته`;
      
      // Set state for tracking (10 min TTL to give user time)
      await redis.set(`order_state:${shopId}:${customerPhone}`, 'waiting_for_more', { ex: 600 });
      
      await this.safeSendMessage(sock, from, message, shop.name);
      
    } catch (error) {
      console.error(`❌ Error in askForMoreItems:`, error);
      await this.safeSendMessage(sock, from, "حدثت مشكلة! يرجى المحاولة مرة أخرى.", shop.name);
    }
  }

  async askForCustomerDetails(sock, from, shopId, customerPhone, shop) {
    try {
      // Set state to waiting for name first
      await redis.set(`order_state:${shopId}:${customerPhone}`, 'waiting_for_name', { ex: 600 });
      
      await this.safeSendMessage(sock, from, 
        `للتواصل معك وتوصيل الطلب، نحتاج بياناتك 📝\n\n` +
        `اكتب اسمك:`, shop.name);
    } catch (error) {
      console.error(`❌ Error asking for details:`, error);
    }
  }

  async handleNameInput(sock, from, shopId, customerPhone, shop, name) {
    try {
      // Validate name - must be at least 2 chars, not just numbers/URLs
      const cleanName = name.trim();
      if (cleanName.length < 2 || /^[\d\s\+\-]+$/.test(cleanName) || /^https?:\/\//i.test(cleanName)) {
        await this.safeSendMessage(sock, from,
          `⚠️ يرجى كتابة اسمك الحقيقي\n` +
          `مثال: *محمد أحمد*\n\n` +
          `أو اكتب *إلغاء* لإلغاء الطلب`, shop.name, shopId, customerPhone);
        return;
      }
      
      // Store name
      await redis.set(`customer_name:${shopId}:${customerPhone}`, cleanName, { ex: 600 });
      
      // Update state to waiting for phone
      await redis.set(`order_state:${shopId}:${customerPhone}`, 'waiting_for_phone', { ex: 600 });
      
      await this.safeSendMessage(sock, from,
        `حسناً ${name}! ✅\n\n` +
        `الآن نحتاج رقم هاتفك 📱\n` +
        `اكتب رقمك بهذا الشكل: 01012345678`, shop.name);
    } catch (error) {
      console.error(`❌ Error handling name:`, error);
    }
  }

  async handlePhoneInput(sock, from, shopId, customerPhone, shop, phone) {
    try {
      // Store phone number
      await redis.set(`customer_phone:${shopId}:${customerPhone}`, phone, { ex: 600 });
      
      // Update state to waiting for address
      await redis.set(`order_state:${shopId}:${customerPhone}`, 'waiting_for_address', { ex: 600 });
      
      await this.safeSendMessage(sock, from,
        `حسناً! رقمك: ${phone} ✅\n\n` +
        `الآن نحتاج عنوان التوصيل 🏠\n\n` +
        `اكتب العنوان بهذا الشكل:\n` +
        `عنوان: شارع التحرير، مدينة نصر، القاهرة\n\n` +
        `أو أي تفاصيل تساعدنا في توصيل طلبك`, shop.name);
    } catch (error) {
      console.error(`❌ Error handling phone:`, error);
    }
  }

  async handleAddressInput(sock, from, shopId, customerPhone, shop, text) {
    try {
      // Extract address (remove "عنوان:" prefix)
      let address = text.replace(/^عنوان[:\s]*/i, '').replace(/^العنوان[:\s]*/i, '').replace(/^address[:\s]*/i, '').trim();
      
      // Store address
      await redis.set(`customer_address:${shopId}:${customerPhone}`, address, { ex: 600 });
      
      // Clear the order state
      await redis.del(`order_state:${shopId}:${customerPhone}`);
      
      // Now confirm the order with details
      await this.confirmOrderWithDetails(sock, from, shopId, customerPhone, shop);
    } catch (error) {
      console.error(`❌ Error handling address:`, error);
    }
  }

  async confirmOrderWithDetails(sock, from, shopId, customerPhone, shop) {
    try {
      const cartKey = `cart:${shopId}:${customerPhone}`;
      let cart = await redis.get(cartKey);
      
      let items = [];
      if (cart) {
        try {
          if (typeof cart === 'string') {
            items = JSON.parse(cart);
          } else if (typeof cart === 'object') {
            items = cart;
          }
        } catch (e) {
          items = [];
        }
      }

      if (items.length === 0) {
        await this.safeSendMessage(sock, from, 
          "سلتك فارغة حالياً 🛒\nاكتب *قائمة* لاستعراض منتجاتنا واختيار ما يناسبك!", shop.name, shopId, customerPhone);
        return;
      }

      // Get customer details
      const customerName = await redis.get(`customer_name:${shopId}:${customerPhone}`) || `عميل ${customerPhone.slice(-4)}`;
      const customerPhoneNumber = await redis.get(`customer_phone:${shopId}:${customerPhone}`) || customerPhone;
      const customerAddress = await redis.get(`customer_address:${shopId}:${customerPhone}`) || 'غير محدد';

      const total = items.reduce((sum, i) => sum + i.price * i.quantity, 0);

      const order = await prisma.order.create({
        data: {
          shopId,
          customerPhone: customerPhoneNumber,
          customerName,
          customerAddress,
          status: "PENDING",
          totalPrice: total,
          orderItems: {
            create: items.map(i => ({
              productId: i.productId,
              quantity: i.quantity,
              price: i.price,
              variantInfo: i.variantInfo || null
            }))
          }
        }
      });

      // Reduce stock after order created
      await this.reduceStock(items, shop, sock);

      // FIX 5: Friendly order confirmed message
      let msg = `تم استلام طلبك بنجاح! 🎉\n\n`;
      msg += `📱 رقم التليفون: ${customerPhoneNumber}\n`;
      msg += `📍 عنوان التوصيل: ${customerAddress}\n\n`;
      msg += `🛒 تفاصيل الطلب:\n`;
      items.forEach((i, idx) => {
        msg += `${idx + 1}. ${i.name}` +
          (i.variantInfo ? ` (${i.variantInfo})` : '') +
          ` × ${i.quantity} = ${i.price * i.quantity} جنيه\n`;
      });
      msg += `\n💰 المجموع الكلي: ${total} جنيه\n\n`;
      msg += `سنتواصل معك قريباً لتأكيد التوصيل 📞\n`;
      msg += `شكراً لاختيارك ${shop.name}! 🙏`;

      await this.safeSendMessage(sock, from, msg, shop.name, shopId, customerPhone);
      
      // Clear cart and temp data
      await redis.del(cartKey);
      await redis.del(`customer_name:${shopId}:${customerPhone}`);
      await redis.del(`customer_phone:${shopId}:${customerPhone}`);
      await redis.del(`customer_address:${shopId}:${customerPhone}`);

      // Notify owner with complete details
      if (shop.whatsappNumber) {
        const ownerMsg = 
          `🔔 *طلب جديد #${order.id.slice(-6)}*\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `👤 *بيانات العميل:*\n` +
          `   الاسم: ${customerName}\n` +
          `   الهاتف: ${customerPhoneNumber}\n` +
          `   العنوان: ${customerAddress || 'لم يُحدد'}\n\n` +
          `📦 *تفاصيل الطلب:*\n` +
          items.map((i, idx) => 
            `   ${idx + 1}. ${i.name}` +
            (i.variantInfo ? ` (${i.variantInfo})` : '') +
            `\n` +
            `      الكمية: ${i.quantity} × ${i.price} جنيه = ${i.quantity * i.price} جنيه`
          ).join('\n') +
          `\n\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `💰 *الإجمالي: ${total} جنيه*\n` +
          `⏰ *الوقت: ${new Date().toLocaleString('ar-EG')}*\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `للتأكيد ردّ بـ "تم" أو افتح لوحة التحكم`;
        
        await this.safeSendMessage(sock, `${shop.whatsappNumber}@s.whatsapp.net`, ownerMsg, shop.name);
      }

    } catch (error) {
      console.error(`❌ Error in confirmOrderWithDetails:`, error);
      await this.safeSendMessage(sock, from, "❌ حدث خطأ أثناء تأكيد الطلب. يرجى المحاولة مرة أخرى.", shop.name);
    }
  }

  async sendNumberedMenu(sock, from, shop, greetingPrefix = '') {
    const menu = greetingPrefix +
                 `✨ كيف يمكنني مساعدتك؟\n\n` +
                 `📋 اكتب "قائمة" - عرض المنتجات\n` +
                 `🛒 اكتب "كارت" - عرض طلبك\n` +
                 `✅ اكتب "اطلب" - اطلب الآن\n` +
                 `❓ اكتب "مساعدة" - للمساعدة\n\n` +
                 `💡 اكتب أي رقم (1, 2, 3...) لإضافة منتج للسلة`;
    await this.safeSendMessage(sock, from, menu, shop.name);
  }

  async sendHelpMessage(sock, from, shop, context = {}) {
    const name = context.name || 'عزيزي';
    let personalizedMsg = '';
    
    if (context.hasItems) {
      personalizedMsg = `🛒 لديك ${context.itemCount} منتج في السلة (${context.totalValue} جنيه)\n\n`;
    }
    
    const msg = `👋 ${name}، أنا مساعد ${shop.name}!\n\n` +
                personalizedMsg +
                `📱 الأوامر المتاحة:\n\n` +
                `📋 *قائمة* - عرض جميع المنتجات\n` +
                `🛒 *كارت* - عرض سلتك\n` +
                `✅ *اطلب* - تأكيد الطلب\n` +
                `✔️ *خلاص* أو *تم* - إتمام الطلب\n` +
                `❌ *إلغاء* - تفريغ السلة\n` +
                `📊 *فين طلبي* - حالة آخر طلب\n` +
                `🚗 *التوصيل* - معلومات التوصيل\n` +
                `➕ *زود [اسم]* - زيادة الكمية\n` +
                `➖ *نقص [اسم]* - تقليل الكمية\n` +
                `🗑️ *شيل [اسم]* - إزالة من السلة\n\n` +
                `💡 أو اكتب رقم المنتج أو اسمه مباشرة\n` +
                `مثال: *2 شاورما* لإضافة 2 شاورما`;
    await this.safeSendMessage(sock, from, msg, shop.name);
  }

  async sendEgyptianResponse(sock, from, text, shop) {
    const lowerText = text.toLowerCase();
    
    // Formal Arabic responses - handle dialect greetings
    if (lowerText.match(/عامل|ازيك|كيف حالك|إيه الأخبار|الأخبار إيه|كيفك|كيف الحال/)) {
      await this.safeSendMessage(sock, from, `أهلاً بك! 👋\n\nكيف يمكنني مساعدتك اليوم؟\nاكتب *قائمة* لعرض منتجاتنا.`, shop.name);
    } else if (lowerText.includes('مرحبا') || lowerText.includes('سلام') || lowerText.includes('اهلا') || lowerText.includes('هلا')) {
      await this.safeSendMessage(sock, from, `أهلاً بك في ${shop.name}! 😊\n\nاكتب "قائمة" لرؤية منتجاتنا.`, shop.name);
    } else if (lowerText.includes('مين') || lowerText.includes('who') || lowerText.includes('انت مين')) {
      await this.safeSendMessage(sock, from, `أنا مساعد ${shop.name}! 🤖\n\nاكتب "مساعدة" لمعرفة الأوامر.`, shop.name);
    } else if (lowerText.includes('سعر') || lowerText.includes('بكم') || lowerText.includes('كام') || lowerText.includes('price')) {
      await this.safeSendMessage(sock, from, `أسعارنا متنوعة! 💰\n\nاكتب "قائمة" لرؤية جميع المنتجات مع أسعارها.`, shop.name);
    } else if (lowerText.includes('طلب') || lowerText.includes('order')) {
      await this.safeSendMessage(sock, from, `للطلب سهل جداً! 👍\n\nاكتب "قائمة" لرؤية المنتجات\nاختر رقم المنتج الذي تريده\nاكتب "اطلب" لتأكيد الطلب`, shop.name);
    } else if (lowerText.includes('منتج') || lowerText.includes('عندك') || lowerText.includes('products')) {
      await this.safeSendMessage(sock, from, `لدينا منتجات ممتازة ومميزة! 🤩\n\nاكتب "قائمة" لرؤية كل ما لدينا.`, shop.name);
    } else if (lowerText.includes('مساعدة') || lowerText.includes('help')) {
      await this.sendHelpMessage(sock, from, shop);
    } else if (lowerText.includes('شكرا') || lowerText.includes('thank')) {
      await this.safeSendMessage(sock, from, `العفو! 🙏\n\nدائماً في خدمتك! اكتب "قائمة" إذا كنت بحاجة لأي شيء آخر.`, shop.name);
    } else {
      // Default - show menu with greeting only for unknown input
      const greeting = `👋 أهلاً بك في ${shop.name}!\n\n`;
      await this.sendNumberedMenu(sock, from, shop, greeting);
    }
  }

  // FIX 4: Smart AI handler for edge cases
  async handleWithAI(sock, from, text, shop, customerPhone) {
    try {
      const cartKey = `cart:${shop.id}:${customerPhone}`;
      const cartData = await redis.get(cartKey);
      let cart = [];
      if (cartData) {
        try {
          cart = typeof cartData === 'string' ? JSON.parse(cartData) : cartData;
        } catch (e) { cart = []; }
      }
      
      const productsList = shop.products
        ? shop.products
            .filter(p => p.isAvailable)
            .map((p, i) => `${i+1}. ${p.name} - ${p.price} جنيه`)
            .join('\n')
        : 'جاري تحميل المنتجات...';
      
      const cartSummary = cart.length > 0
        ? `السلة تحتوي على: ${cart.map(i => `${i.quantity}x ${i.name}`).join('، ')}` 
        : 'السلة فارغة';
      
      const systemPrompt = `أنت موظف خدمة عملاء اسمك *ذكي* تعمل في متجر "${shop.name}".

هويتك:
- اسمك: ذكي
- وظيفتك: موظف خدمة عملاء محترف
- إذا سألك العميل عن اسمك قل: "أنا ذكي، موظف خدمة العملاء"
- إذا سألك من أنت قل: "أنا ذكي، موظف خدمة العملاء في ${shop.name}"
- لا تقل أبداً أنك بوت أو روبوت أو ذكاء اصطناعي

قواعد اللغة - صارمة جداً:
1. استخدم اللغة العربية الفصحى الرسمية فقط
2. ممنوع منعاً باتاً: أيوه، لأ، تمام، ماشي، كويس،
   عامل، ازيك، يلا، بص، معلش، خلاص، زي، أوي،
   دلوقتي، عايز، مش، إيه، فين، ازاي، بقى، كمان
3. الكلمات الصحيحة: نعم، لا، حسناً، الآن، تريد،
   ليس، ما، أين، كيف، أيضاً، عفواً
4. لا أخطاء إملائية أبداً
5. ردودك قصيرة ومختصرة لا تتجاوز 3 جمل
6. كن محترفاً ومهذباً في جميع الأوقات
7. لا تكرر نفس الرد مرتين
8. تذكر دائماً أنك تمثل صورة المتجر

منتجاتنا المتاحة:
${productsList}

حالة سلة العميل: ${cartSummary}

تعليمات إضافية:
- إذا أراد العميل إلغاء شيء قله يكتب "إلغاء"
- إذا أراد رؤية القائمة قله يكتب "قائمة"
- إذا أراد تأكيد الطلب قله يكتب "اطلب"
- إذا بدا العميل محبطاً اعتذر بلطف وساعده`;
      
      const aiReply = await this.getGroqResponse(text, shop, { hasItems: cart.length > 0 }, 'neutral', 'general', customerPhone, '');
      
      if (aiReply) {
        await sock.sendMessage(from, { text: aiReply });
        console.log(`🤖 AI replied to: "${text}"`);
        
        // Update message history
        await this.updateMessageHistory(shop.id, customerPhone, aiReply, 'bot', 'ai_response');
      } else {
        // Fallback if AI fails
        await sock.sendMessage(from, { 
          text: `عذراً على الإزعاج! 🙏\nيمكنك كتابة:\n📋 *قائمة* - لعرض المنتجات\n✅ *اطلب* - لتأكيد طلبك\n❌ *إلغاء* - لمسح السلة` 
        });
      }
    } catch (err) {
      console.error('AI handler error:', err);
      // Friendly fallback
      await sock.sendMessage(from, { 
        text: `عذراً على الإزعاج! 🙏\nيمكنك كتابة:\n📋 *قائمة* - لعرض المنتجات\n✅ *اطلب* - لتأكيد طلبك\n❌ *إلغاء* - لمسح السلة` 
      });
    }
  }

  async addProductToCartWithVariant(
    sock, from, shop, customerPhone, product, variantInfo = null
  ) {
    // Check stock first
    if (product.stock !== null &&
        product.stock !== undefined &&
        product.stock <= 0) {
      await sock.sendMessage(from, {
        text: `عذراً، *${product.name}* غير متوفر حالياً.\n` +
              `سيتوفر قريباً إن شاء الله 🙏` 
      })
      return
    }

    // Check if needs variant selection
    if (product.variants && !variantInfo) {
      let variantGroups = []
      try { variantGroups = JSON.parse(product.variants) } catch {}

      if (variantGroups.length > 0) {
        const pendingVariantKey =
          `pendingvariant:${shop.id}:${customerPhone}` 

        await redis.set(pendingVariantKey, JSON.stringify({
          productId: product.id,
          name: product.name,
          price: product.price,
          variants: variantGroups
        }), { ex: 300 })

        // Build variant options text, hiding out-of-stock options
        const variantLines = variantGroups.map(g => {
          const available = g.options.filter(o => {
            if (!g.stock) return true
            const s = g.stock[o]
            return s === null || s === undefined || s > 0
          })
          const unavailable = g.options.filter(o => {
            if (!g.stock) return false
            const s = g.stock[o]
            return s !== null && s !== undefined && s <= 0
          })
          let line = `*${g.name}:*\n` + available.map(o => `• ${o}`).join('\n')
          if (unavailable.length > 0) {
            line += `\n` + unavailable.map(o => `• ~${o}~ (غير متوفر حالياً)`).join('\n')
          }
          return line
        })

        const firstAvailable = variantGroups.map(g => {
          const avail = g.options.find(o => {
            if (!g.stock) return true
            const s = g.stock[o]
            return s === null || s === undefined || s > 0
          })
          return avail ? `${g.name}: ${avail}` : null
        }).filter(Boolean)

        await sock.sendMessage(from, {
          text: `لإضافة *${product.name}* إلى سلتك،\n` +
                `يرجى اختيار:\n\n` +
                variantLines.join('\n\n') +
                (firstAvailable.length > 0 ? `\n\nأرسل اختياراتك مثال:\n` + firstAvailable.join('\n') : '') +
                `\n\nأو اكتب *إلغاء* للرجوع` 
        })
        return
      }
    }

    // Add to cart
    const cartKey = `cart:${shop.id}:${customerPhone}` 
    const cartData = await redis.get(cartKey)
    let cart = []
    try { cart = cartData ? (typeof cartData === 'string' ? JSON.parse(cartData) : cartData) : [] } catch(e) { cart = [] }

    const cartItemKey = variantInfo
      ? `${product.id}__${variantInfo}` 
      : product.id

    const existingIndex = cart.findIndex(
      i => i.cartItemKey === cartItemKey
    )

    // Check per-variant stock limit
    let variantStockLimit = null
    if (variantInfo && product.variants) {
      try {
        const vGroups = typeof product.variants === 'string' ? JSON.parse(product.variants) : product.variants
        for (const g of vGroups) {
          if (g.stock) {
            for (const opt of g.options) {
              if (variantInfo.includes(opt) && g.stock[opt] !== null && g.stock[opt] !== undefined) {
                variantStockLimit = variantStockLimit === null ? g.stock[opt] : Math.min(variantStockLimit, g.stock[opt])
              }
            }
          }
        }
      } catch(e) {}
    }

    // Use variant stock if available, otherwise fall back to product stock
    const effectiveStock = variantStockLimit !== null ? variantStockLimit : 
      (product.stock !== null && product.stock !== undefined ? product.stock : null)

    if (effectiveStock !== null) {
      const currentQty = existingIndex >= 0 ? cart[existingIndex].quantity : 0
      if (effectiveStock <= 0) {
        await sock.sendMessage(from, {
          text: `عذراً، *${product.name}*${variantInfo ? ` (${variantInfo})` : ''} غير متوفر حالياً 😔\nسيتوفر قريباً إن شاء الله 🙏`
        })
        return
      }
      if (currentQty >= effectiveStock) {
        await sock.sendMessage(from, {
          text: `عذراً، وصلت للحد الأقصى المتاح من *${product.name}*${variantInfo ? ` (${variantInfo})` : ''} حالياً.\nجرّب خيار آخر أو تابعنا لمعرفة وقت التوفر 🙏`
        })
        return
      }
    }

    if (existingIndex >= 0) {
      cart[existingIndex].quantity += 1
    } else {
      cart.push({
        cartItemKey,
        productId: product.id,
        name: product.name,
        price: product.price,
        quantity: 1,
        variantInfo: variantInfo || null
      })
    }

    await redis.set(cartKey, JSON.stringify(cart), { ex: 3600 })

    const total = cart.reduce((s, i) => s + i.price * i.quantity, 0)
    const variantText = variantInfo ? ` (${variantInfo})` : ''

    await sock.sendMessage(from, {
      text: `تمت إضافة *${product.name}*${variantText} ✅\n` +
            `إجمالي سلتك: ${total} جنيه\n\n` +
            `اكتب *قائمة* لإضافة المزيد\n` +
            `أو *اطلب* لتأكيد طلبك` 
    })
  }

  // Handle "خلاص/بس/كده/تم" - customer is done, proceed to order
  async handleDoneResponse(sock, from, shop, customerPhone) {
    const cartKey = `cart:${shop.id}:${customerPhone}`;
    let cart = await redis.get(cartKey);
    let items = [];
    if (cart) {
      try { items = typeof cart === 'string' ? JSON.parse(cart) : cart; } catch (e) { items = []; }
    }

    if (items.length === 0) {
      await this.safeSendMessage(sock, from,
        `سلتك فارغة حالياً 🛒\n\nاكتب *قائمة* لاستعراض منتجاتنا واختيار ما يناسبك!`, shop.name, shop.id, customerPhone);
      return;
    }

    // Customer has items - proceed to order details
    const total = items.reduce((sum, i) => sum + i.price * i.quantity, 0);
    await this.safeSendMessage(sock, from,
      `حسناً! لديك ${items.length} منتج بإجمالي ${total} جنيه ✅\n\n` +
      `سنبدأ الآن بتسجيل بيانات التوصيل... 📝`, shop.name, shop.id, customerPhone);
    
    await this.askForCustomerDetails(sock, from, shop.id, customerPhone, shop);
  }

  // Handle "شكرا" response
  async handleThanksResponse(sock, from, shop, customerPhone, context) {
    const responses = [
      `العفو! دائماً في خدمتك 😊\nإذا احتجت أي شيء اكتب *قائمة* أو *مساعدة*`,
      `شكراً لك! نسعد بخدمتك دائماً 🙏\nاكتب *قائمة* إذا أردت طلب شيء آخر`,
      `بارك الله فيك! 🌟\nنحن في خدمتك دائماً، اكتب *قائمة* لتصفح المنتجات 😊`,
    ];
    const response = responses[Math.floor(Math.random() * responses.length)];
    
    if (context.hasItems) {
      await this.safeSendMessage(sock, from,
        `${response}\n\n💡 بالمناسبة، لديك ${context.itemCount} منتج في السلة. اكتب *اطلب* لتأكيد طلبك!`, shop.name, shop.id, customerPhone);
    } else {
      await this.safeSendMessage(sock, from, response, shop.name, shop.id, customerPhone);
    }
  }

  // Handle order status inquiry
  async handleOrderStatus(sock, from, shop, customerPhone) {
    try {
      // Get last order for this customer
      const lastOrder = await prisma.order.findFirst({
        where: {
          shopId: shop.id,
          customerPhone: { contains: customerPhone.slice(-10) }
        },
        orderBy: { createdAt: 'desc' },
        include: { orderItems: true }
      });

      if (!lastOrder) {
        await this.safeSendMessage(sock, from,
          `لم نجد طلبات سابقة لك 📋\n\nاكتب *قائمة* لتصفح منتجاتنا وإنشاء طلب جديد!`, shop.name, shop.id, customerPhone);
        return;
      }

      const statusMap = {
        'PENDING': '⏳ قيد الانتظار',
        'CONFIRMED': '✅ تم التأكيد',
        'PREPARING': '👨‍🍳 جاري التحضير',
        'DELIVERING': '🚗 في الطريق إليك',
        'DELIVERED': '📦 تم التوصيل',
        'CANCELLED': '❌ ملغي'
      };

      const statusText = statusMap[lastOrder.status] || lastOrder.status;
      const orderDate = new Date(lastOrder.createdAt).toLocaleString('ar-EG');

      await this.safeSendMessage(sock, from,
        `📋 *آخر طلب لك:*\n\n` +
        `🔢 رقم الطلب: #${lastOrder.id.slice(-6)}\n` +
        `📅 التاريخ: ${orderDate}\n` +
        `💰 الإجمالي: ${lastOrder.totalPrice} جنيه\n` +
        `📊 الحالة: ${statusText}\n\n` +
        `للاستفسار أكثر تواصل مع صاحب المتجر مباشرة 📞`, shop.name, shop.id, customerPhone);
    } catch (error) {
      console.error('Order status error:', error);
      await this.safeSendMessage(sock, from,
        `عذراً، لم أتمكن من جلب حالة الطلب حالياً 😅\nيرجى التواصل مع صاحب المتجر مباشرة.`, shop.name, shop.id, customerPhone);
    }
  }

  // Handle delivery questions
  async handleDeliveryQuestion(sock, from, shop, customerPhone, text) {
    await this.safeSendMessage(sock, from,
      `🚗 *معلومات التوصيل:*\n\n` +
      `نحن نوصل لجميع المناطق القريبة.\n` +
      `تفاصيل التوصيل ومصاريفه يتم تحديدها حسب موقعك.\n\n` +
      `للمزيد من التفاصيل، يمكنك:\n` +
      `1️⃣ إتمام طلبك وسنتواصل معك لتأكيد التفاصيل\n` +
      `2️⃣ التواصل مع صاحب المتجر مباشرة 📞\n\n` +
      `اكتب *قائمة* لتصفح المنتجات 📋`, shop.name, shop.id, customerPhone);
  }

  // Handle change quantity command (زود/نقص/غير)
  async handleChangeQuantity(sock, from, shop, customerPhone, text) {
    try {
      const cartKey = `cart:${shop.id}:${customerPhone}`;
      let cart = await redis.get(cartKey);
      let items = [];
      if (cart) {
        try { items = typeof cart === 'string' ? JSON.parse(cart) : cart; } catch (e) { items = []; }
      }

      if (items.length === 0) {
        await this.safeSendMessage(sock, from,
          `السلة فارغة! 🛒\nاكتب *قائمة* لإضافة منتجات.`, shop.name, shop.id, customerPhone);
        return;
      }

      const lowerText = text.toLowerCase();
      const isIncrease = lowerText.startsWith('زود');
      const isDecrease = lowerText.startsWith('نقص');
      const itemName = text.substring(text.indexOf(' ') + 1).trim();

      // Find item in cart
      const itemIndex = items.findIndex(item =>
        item.name.toLowerCase().includes(itemName.toLowerCase()) ||
        itemName.toLowerCase().includes(item.name.toLowerCase())
      );

      if (itemIndex === -1) {
        await this.safeSendMessage(sock, from,
          `لم أجد "${itemName}" في السلة 😕\n\nاكتب *كارت* لعرض محتويات السلة.`, shop.name, shop.id, customerPhone);
        return;
      }

      if (isIncrease) {
        items[itemIndex].quantity += 1;
        await redis.set(cartKey, JSON.stringify(items), { ex: 3600 });
        const total = items.reduce((sum, i) => sum + i.price * i.quantity, 0);
        await this.safeSendMessage(sock, from,
          `تم زيادة كمية ${items[itemIndex].name} إلى ${items[itemIndex].quantity} ✅\nالإجمالي: ${total} جنيه`, shop.name, shop.id, customerPhone);
      } else if (isDecrease) {
        if (items[itemIndex].quantity <= 1) {
          items.splice(itemIndex, 1);
          if (items.length === 0) {
            await redis.del(cartKey);
          } else {
            await redis.set(cartKey, JSON.stringify(items), { ex: 3600 });
          }
          await this.safeSendMessage(sock, from,
            `تم إزالة المنتج من السلة ✅`, shop.name, shop.id, customerPhone);
        } else {
          items[itemIndex].quantity -= 1;
          await redis.set(cartKey, JSON.stringify(items), { ex: 3600 });
          const total = items.reduce((sum, i) => sum + i.price * i.quantity, 0);
          await this.safeSendMessage(sock, from,
            `تم تقليل كمية ${items[itemIndex].name} إلى ${items[itemIndex].quantity} ✅\nالإجمالي: ${total} جنيه`, shop.name, shop.id, customerPhone);
        }
      } else {
        // غير - show current quantity and ask
        await this.safeSendMessage(sock, from,
          `${items[itemIndex].name} - الكمية الحالية: ${items[itemIndex].quantity}\n\n` +
          `اكتب *زود ${itemName}* لزيادة الكمية\n` +
          `اكتب *نقص ${itemName}* لتقليل الكمية\n` +
          `اكتب *شيل ${itemName}* لإزالته`, shop.name, shop.id, customerPhone);
      }
    } catch (error) {
      console.error('Change quantity error:', error);
      await this.safeSendMessage(sock, from, `عذراً، حدث خطأ. يرجى المحاولة مرة أخرى 🙏`, shop.name);
    }
  }

  // Add product to cart by name with specific quantity
  async addToCartByNameWithQty(sock, from, shop, customerPhone, productName, qty) {
    const matches = findBestMatch(productName, shop.products);

    if (matches.length >= 1 && matches[0].score >= 0.7) {
      const product = matches[0].product;

      // Check stock
      if (product.stock !== null && product.stock !== undefined) {
        if (product.stock <= 0) {
          await this.safeSendMessage(sock, from,
            `عذراً، *${product.name}* غير متوفر حالياً 😔\nسيتوفر قريباً إن شاء الله 🙏`, shop.name, shop.id, customerPhone);
          return;
        }
        if (qty > product.stock) {
          await this.safeSendMessage(sock, from,
            `عذراً، الكمية المطلوبة من *${product.name}* غير متوفرة حالياً.\nجرّب كمية أقل أو تابعنا لمعرفة وقت التوفر 🙏`, shop.name, shop.id, customerPhone);
          return;
        }
      }

      // Check variants
      if (product.variants) {
        let variantGroups = [];
        try { variantGroups = JSON.parse(product.variants); } catch {}
        if (variantGroups.length > 0) {
          // Has variants - add one at a time
          await this.addProductToCartWithVariant(sock, from, shop, customerPhone, product);
          return;
        }
      }

      // Add with quantity
      const cartKey = `cart:${shop.id}:${customerPhone}`;
      const cartData = await redis.get(cartKey);
      let cart = []
      try { cart = cartData ? (typeof cartData === 'string' ? JSON.parse(cartData) : cartData) : [] } catch(e) { cart = [] }

      const existingIndex = cart.findIndex(i => i.productId === product.id);
      if (existingIndex >= 0) {
        cart[existingIndex].quantity += qty;
      } else {
        cart.push({
          cartItemKey: product.id,
          productId: product.id,
          name: product.name,
          price: product.price,
          quantity: qty,
          variantInfo: null
        });
      }

      await redis.set(cartKey, JSON.stringify(cart), { ex: 3600 });
      const total = cart.reduce((s, i) => s + i.price * i.quantity, 0);

      await this.safeSendMessage(sock, from,
        `تمت إضافة *${product.name}* × ${qty} ✅\n` +
        `إجمالي سلتك: ${total} جنيه\n\n` +
        `اكتب *قائمة* لإضافة المزيد\nأو *اطلب* لتأكيد طلبك`, shop.name, shop.id, customerPhone);
    } else {
      await this.safeSendMessage(sock, from,
        `لم أجد منتج بهذا الاسم 😕\nاكتب *قائمة* لرؤية المنتجات المتاحة.`, shop.name, shop.id, customerPhone);
    }
  }

  async reduceStock(cart, shop, sock) {
    for (const item of cart) {
      try {
        const product = await prisma.product.findUnique({
          where: { id: item.productId }
        })

        if (!product) continue

        const updateData = {}

        // Reduce variant-level stock if item has variantInfo
        if (item.variantInfo && product.variants) {
          try {
            const vGroups = typeof product.variants === 'string' ? JSON.parse(product.variants) : product.variants
            let variantChanged = false

            // Parse variantInfo like "اللون: أحمر - المقاس: L" or "اللون: أحمر، المقاس: L"
            const parts = item.variantInfo.split(/\s*[-،,]\s*/)
            for (const part of parts) {
              const [, val] = part.split(':').map(s => s.trim())
              if (!val) continue
              for (const g of vGroups) {
                if (g.stock && g.stock[val] !== null && g.stock[val] !== undefined) {
                  const oldStock = g.stock[val]
                  g.stock[val] = Math.max(0, oldStock - item.quantity)
                  variantChanged = true

                  // Notify owner when a specific variant option runs out
                  if (g.stock[val] === 0 && oldStock > 0) {
                    try {
                      await sock.sendMessage(
                        `${shop.whatsappNumber}@s.whatsapp.net`,
                        {
                          text: `🔴 *تنبيه: نفذ خيار من المنتج*\n` +
                                `المنتج: *${product.name}*\n` +
                                `${g.name}: *${val}* نفذ بالكامل\n\n` +
                                `يرجى إعادة تعبئة المخزون من لوحة التحكم`
                        }
                      )
                    } catch (e) { console.error('Variant notify error:', e) }
                  } else if (g.stock[val] > 0 && g.stock[val] <= 3 && oldStock > 3) {
                    try {
                      await sock.sendMessage(
                        `${shop.whatsappNumber}@s.whatsapp.net`,
                        {
                          text: `⚠️ *تنبيه: كمية منخفضة*\n` +
                                `المنتج: *${product.name}*\n` +
                                `${g.name}: *${val}* - متبقي ${g.stock[val]} فقط`
                        }
                      )
                    } catch (e) { console.error('Variant notify error:', e) }
                  }
                }
              }
            }

            if (variantChanged) {
              updateData.variants = JSON.stringify(vGroups)
            }
          } catch (e) {
            console.error('Variant stock reduce error:', e)
          }
        }

        // Reduce product-level stock
        if (product.stock !== null && product.stock !== undefined) {
          const newStock = Math.max(0, product.stock - item.quantity)
          updateData.stock = newStock
          updateData.isAvailable = newStock > 0

          if (newStock > 0 && newStock <= 3) {
            try {
              await sock.sendMessage(
                `${shop.whatsappNumber}@s.whatsapp.net`,
                {
                  text: `⚠️ *تنبيه: كمية منخفضة*\n` +
                        `المنتج: *${product.name}*\n` +
                        `الكمية المتبقية: ${newStock} فقط`
                }
              )
            } catch (e) {}
          }

          if (newStock === 0) {
            try {
              await sock.sendMessage(
                `${shop.whatsappNumber}@s.whatsapp.net`,
                {
                  text: `🔴 *تنبيه: نفذت الكمية*\n` +
                        `المنتج: *${product.name}* نفذ بالكامل`
                }
              )
            } catch (e) {}
          }
        }

        if (Object.keys(updateData).length > 0) {
          await prisma.product.update({
            where: { id: item.productId },
            data: updateData
          })
          this.invalidateShopCache(shop.id)
        }

      } catch (err) {
        console.error('Stock reduce error:', err)
      }
    }
  }

  // Handle discount/offer questions
  async handleDiscountQuestion(sock, from, shop, customerPhone) {
    const responses = [
      `🏷️ أهلاً بك!\n\nأسعارنا تنافسية جداً ومناسبة للجميع.\nتابعنا دائماً لأن العروض والخصومات بتنزل باستمرار! 🔥\n\nاكتب *قائمة* لتصفح المنتجات والأسعار 📋`,
      `💫 حالياً أسعارنا هي أفضل الأسعار في السوق!\n\nإذا أردت رؤية المنتجات والأسعار اكتب *قائمة* 📋\nوسنعلن عن أي عروض جديدة فوراً! 🎉`,
    ];
    await this.safeSendMessage(sock, from,
      responses[Math.floor(Math.random() * responses.length)], shop.name, shop.id, customerPhone);
  }

  // Handle payment method questions
  async handlePaymentQuestion(sock, from, shop, customerPhone) {
    await this.safeSendMessage(sock, from,
      `💳 *طرق الدفع المتاحة:*\n\n` +
      `💵 الدفع عند الاستلام (كاش)\n` +
      `📱 فودافون كاش / اتصالات كاش / محفظة إلكترونية\n` +
      `🏦 تحويل بنكي\n\n` +
      `يتم تحديد تفاصيل الدفع بعد تأكيد الطلب.\n` +
      `اكتب *اطلب* لتأكيد طلبك وسنتواصل معك! 📞`, shop.name, shop.id, customerPhone);
  }

  // Handle working hours questions
  async handleWorkingHoursQuestion(sock, from, shop, customerPhone) {
    if (shop.isAlwaysOpen !== false) {
      await this.safeSendMessage(sock, from,
        `🕐 *مواعيد العمل:*\n\n` +
        `نحن متاحون على مدار الساعة! 📱\n` +
        `✅ المتجر مفتوح الآن\n\n` +
        `اكتب *قائمة* لتصفح المنتجات 📋`, shop.name, shop.id, customerPhone);
      return;
    }

    const schedule = getWorkingHoursSchedule(shop);
    const open = isShopOpen(shop);
    await this.safeSendMessage(sock, from,
      `🕐 *مواعيد العمل:*\n\n${schedule}\n\n` +
      (open ? `✅ المتجر مفتوح الآن! ابدأ طلبك 🚀` : `🔴 المتجر مغلق حالياً\n🕐 هنفتح ${getNextOpenTime(shop)}`) +
      `\n\nاكتب *قائمة* لتصفح المنتجات 📋`, shop.name, shop.id, customerPhone);
  }

  // Handle location/branch questions
  async handleLocationQuestion(sock, from, shop, customerPhone) {
    await this.safeSendMessage(sock, from,
      `📍 *${shop.name}*\n\n` +
      `نحن متجر إلكتروني ونوصل لك حتى باب منزلك! 🚗\n\n` +
      `لمعرفة تفاصيل التوصيل لمنطقتك،\n` +
      `ابدأ طلبك وسنتواصل معك لتأكيد جميع التفاصيل 📞\n\n` +
      `اكتب *قائمة* لتصفح المنتجات 📋\n` +
      `أو *اطلب* لتأكيد طلبك ✅`, shop.name, shop.id, customerPhone);
  }

  // Handle return/warranty questions
  async handleReturnPolicyQuestion(sock, from, shop, customerPhone) {
    await this.safeSendMessage(sock, from,
      `🔄 *سياسة الإرجاع والاستبدال:*\n\n` +
      `رضا العميل هو أولويتنا! 🌟\n\n` +
      `✅ إذا كان المنتج به أي عيب أو غير مطابق - نبدّله فوراً\n` +
      `✅ إذا لم يكن مناسباً لك - تواصل معنا وسنحل الأمر\n` +
      `📞 تواصل مع صاحب المتجر مباشرة لأي استفسار\n\n` +
      `اكتب *قائمة* لتصفح المنتجات 📋`, shop.name, shop.id, customerPhone);
  }

  // Handle recommendation requests
  async handleRecommendation(sock, from, shop, customerPhone) {
    const availableProducts = shop.products.filter(p => p.isAvailable);
    
    if (availableProducts.length === 0) {
      await this.safeSendMessage(sock, from,
        `عذراً، لا توجد منتجات متاحة حالياً 😅\nتابعنا وسنضيف منتجات جديدة قريباً!`, shop.name, shop.id, customerPhone);
      return;
    }

    // Pick top 3 (or all if less)
    const topProducts = availableProducts.slice(0, Math.min(3, availableProducts.length));
    
    await this.safeSendMessage(sock, from,
      `⭐ *مقترحاتنا لك:*\n\n` +
      topProducts.map((p, i) => 
        `${i + 1}. *${p.name}* - ${p.price} جنيه`
      ).join('\n') +
      `\n\n💡 اكتب رقم المنتج لإضافته للسلة\n` +
      `أو اكتب *قائمة* لرؤية كل المنتجات 📋`, shop.name, shop.id, customerPhone);
  }

  // Handle talk to human request
  async handleTalkToHuman(sock, from, shop, customerPhone) {
    await this.safeSendMessage(sock, from,
      `👤 أنا *ذكي*، موظف خدمة العملاء في *${shop.name}*\n\n` +
      `سأبذل قصارى جهدي لمساعدتك! وإذا أردت التواصل مع صاحب المتجر مباشرة:\n` +
      `📞 سيتواصل معك بعد تسجيل طلبك\n\n` +
      `💡 يمكنني مساعدتك في أغلب الأمور! جرّب:\n` +
      `📋 *قائمة* - لعرض المنتجات\n` +
      `🛒 *كارت* - لعرض السلة\n` +
      `❓ *مساعدة* - لعرض جميع الأوامر`, shop.name, shop.id, customerPhone);
  }

  // Handle what's new questions
  async handleWhatsNew(sock, from, shop, customerPhone) {
    const availableProducts = shop.products.filter(p => p.isAvailable);
    
    if (availableProducts.length === 0) {
      await this.safeSendMessage(sock, from,
        `نجهّز منتجات جديدة حالياً! 🎉\nتابعنا وسنعلن عن كل جديد قريباً`, shop.name, shop.id, customerPhone);
      return;
    }

    // Show latest products (last added)
    const latest = availableProducts.slice(-Math.min(3, availableProducts.length));
    
    await this.safeSendMessage(sock, from,
      `🆕 *أحدث المنتجات:*\n\n` +
      latest.map((p, i) => 
        `${i + 1}. *${p.name}* - ${p.price} جنيه`
      ).join('\n') +
      `\n\n💡 اكتب رقم المنتج أو اسمه لإضافته للسلة\n` +
      `أو اكتب *قائمة* لرؤية كل المنتجات 📋`, shop.name, shop.id, customerPhone);
  }

  // Handle affirmative responses (طب، ماشي، تمام، حاضر)
  async handleAffirmative(sock, from, shop, customerPhone, context) {
    if (context.hasItems) {
      await this.safeSendMessage(sock, from,
        `حسناً! 👍\n\n` +
        `لديك ${context.itemCount} منتج في السلة (${context.totalValue} جنيه)\n\n` +
        `اكتب *قائمة* لإضافة المزيد\n` +
        `أو *اطلب* لتأكيد الطلب ✅`, shop.name, shop.id, customerPhone);
    } else {
      await this.safeSendMessage(sock, from,
        `حسناً! 👍 كيف يمكنني مساعدتك؟\n\n` +
        `اكتب *قائمة* لتصفح المنتجات 📋\n` +
        `أو اكتب اسم المنتج الذي تريده مباشرة!`, shop.name, shop.id, customerPhone);
    }
  }

  // Helper to get cart contents
  async getCartContents(shopId, customerPhone) {
    const cartKey = `cart:${shopId}:${customerPhone}`;
    const cartData = await redis.get(cartKey);
    if (!cartData) return [];
    try {
      return typeof cartData === 'string' ? JSON.parse(cartData) : cartData;
    } catch (e) {
      return [];
    }
  }

  getConnectionState(shopId) {
    return this.connectionStates.get(shopId) || 'not_started';
  }

  isShopConnected(shopId) {
    return this.connectionStates.get(shopId) === 'connected';
  }

  // QR code management helpers
  setCurrentQr(shopId, qr) {
    this.currentQrs.set(shopId, qr);
  }

  getCurrentQr(shopId) {
    return this.currentQrs.get(shopId) || null;
  }

  clearCurrentQr(shopId) {
    this.currentQrs.delete(shopId);
  }

  isConnecting(shopId) {
    return this.connectionStates.get(shopId) === 'connecting';
  }

  async disconnectShop(shopId) {
    const sock = this.connections.get(shopId);
    if (sock) {
      try {
        await sock.logout();
      } catch (e) {
        // Ignore logout errors
      }
      this.connections.delete(shopId);
      this.connectionStates.delete(shopId);
      this.qrCallbacks.delete(shopId);
    }
  }
}

module.exports = new BotManager();
