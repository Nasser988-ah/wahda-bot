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

// Find best matching product
function findBestMatch(text, products) {
  const normalizedInput = normalizeArabic(text);
  const candidates = [];

  products.filter(p => p.isAvailable).forEach(p => {
    const normalizedName = normalizeArabic(p.name);

    // Exact match
    if (normalizedInput === normalizedName) {
      candidates.push({ product: p, score: 1.0 });
      return;
    }

    // Input is contained in product name
    if (normalizedName.includes(normalizedInput)) {
      candidates.push({ product: p, score: 0.95 });
      return;
    }

    // Product name is contained in input
    if (normalizedInput.includes(normalizedName)) {
      candidates.push({ product: p, score: 0.9 });
      return;
    }

    // Word-by-word matching
    const inputWords = normalizedInput.split(' ').filter(w => w.length > 1);
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
    cart: cart ? JSON.parse(cart) : [],
    state,
    isFirstTime: !firstTime,
    pending: pending ? JSON.parse(pending) : null,
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
    
    // Also log stack trace to see who's calling this
    console.log(`🔄 invalidateShopCache called from:`, new Error().stack.split('\n')[2]?.trim());
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
              setTimeout(() => reject(new Error('Message handling timeout')), 10000)
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

      if (!text.trim()) return;

      console.log(`📩 ${shop.name} - Message from ${customerPhone}: "${text}"`);

      const lowerText = text.toLowerCase().trim();

      // Check pending variant selection
      const pendingVariantKey =
        `pendingvariant:${shop.id}:${customerPhone}` 
      const pendingVariantData = await redis.get(pendingVariantKey)

      if (pendingVariantData) {
        const pendingVariant = JSON.parse(pendingVariantData)

        // Allow cancel
        if (/^(الغاء|إلغاء|إلغي|الغي|cancel)$/i.test(text.trim())) {
          await redis.del(pendingVariantKey)
          await sock.sendMessage(from, {
            text: 'تم الإلغاء. اكتب *قائمة* لعرض المنتجات.'
          })
          return
        }

        // Parse variant choices (customer sends "اللون: أحمر\nالمقاس: L")
        const lines = text.split('\n').filter(l => l.includes(':'))

        if (lines.length > 0) {
          const variantInfo = lines.map(l => l.trim()).join(' - ')
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

        // Customer didn't follow format - remind them
        await sock.sendMessage(from, {
          text: `يرجى إرسال اختياراتك بهذا الشكل:\n\n` +
                pendingVariant.variants.map(g =>
                  `${g.name}: (اختيارك)` 
                ).join('\n') +
                `\n\nالخيارات المتاحة:\n` +
                pendingVariant.variants.map(g =>
                  `*${g.name}:* ${g.options.join('، ')}` 
                ).join('\n') +
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
        const pending = JSON.parse(pendingData);
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
          const phone = text.replace(/\s/g, '');
          if (/^0?1\d{9}$/.test(phone)) {
            await this.handlePhoneInput(sock, from, shop.id, customerPhone, shop, phone);
          } else {
            // Check if it's a question or cancel (already handled above)
            await this.safeSendMessage(sock, from, 
              `⚠️ رقم الهاتف غير صحيح\n\n` +
              `يرجى كتابة الرقم بالصيغة الصحيحة: 01012345678 📱\n` +
              `أو اكتب *إلغاء* لإلغاء الطلب`, shop.name, shop.id, customerPhone);
          }
          return;
        } else if (orderState === 'waiting_for_address') {
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
      
      // Track message count for AI takeover decision
      const msgCountKey = `msgcount:${shop.id}:${customerPhone}`;
      const msgCount = parseInt(await redis.get(msgCountKey) || '0') + 1;
      await redis.set(msgCountKey, msgCount, { ex: 3600 });
      
      // IMPORTANT: Check basic commands FIRST before any AI logic
      if (this.matchesIntent(lowerText, 'menu')) {
        console.log(`✓ Matched: menu`);
        await this.sendProductsList(sock, from, shop, customerPhone, 1);
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
      } else if (/^0?1\d{9}$/.test(text.replace(/\s/g, ''))) {
        console.log(`✓ Matched: phone number`);
        await this.handlePhoneInput(sock, from, shop.id, customerPhone, shop, text.replace(/\s/g, ''));
        return;
      } else if (lowerText.startsWith('صفحة ') || lowerText.startsWith('page ')) {
        console.log(`✓ Matched: page navigation`);
        const pageNum = parseInt(text.split(' ')[1]) || 1;
        await this.sendProductsList(sock, from, shop, customerPhone, pageNum);
        return;
      } else if (this.matchesIntent(lowerText, 'cancel')) {
        console.log(`✓ Matched: cancel`);
        await this.handleCancelCommand(sock, from, shop, customerPhone, context);
        return;
      } else if (lowerText.startsWith('شيل ') || lowerText.startsWith('احذف ') || lowerText.startsWith('امسح ')) {
        console.log(`✓ Matched: remove item command`);
        const itemName = text.substring(text.indexOf(' ') + 1).trim();
        await this.removeFromCart(sock, from, shop.id, customerPhone, itemName, shop);
        return;
      } else if (/^\d+$/.test(text)) {
        console.log(`✓ Matched: product number`);
        await this.addToCart(sock, from, shop.id, customerPhone, parseInt(text), shop);
        return;
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
      // FIX 2: Check last message sent to prevent duplicates
      if (shopId && customerPhone) {
        const lastMsgKey = `lastmsg:${shopId}:${customerPhone}`;
        const lastMsg = await redis.get(lastMsgKey);
        
        // If same message, warn and continue (allow caller to decide if they want AI)
        if (lastMsg === message) {
          console.log('⚠️ Duplicate message detected - same message already sent');
          return { duplicate: true, sent: false };
        }
        
        // Save this message as last sent (expires in 1 hour)
        await redis.set(lastMsgKey, message, { ex: 3600 });
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
    const storeUrl = `${baseUrl}/store.html?shopId=${shop.id}&phone=${shop.whatsappNumber}`;
    
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

      // Use the new addProductToCartWithVariant method
      await this.addProductToCartWithVariant(
        sock, from, shop, customerPhone, product
      );
      
      console.log(`✅ Added ${product.name} to cart for ${customerPhone}`);
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

      let message = `🛒 سلة التسوق:\n\n`;
      let total = 0;
      items.forEach((item, i) => {
        const subtotal = item.price * item.quantity;
        total += subtotal;
        message += `${i + 1}. ${item.name}` +
          (item.variantInfo ? ` (${item.variantInfo})` : '') +
          `\n`;
        message += `الكمية: ${item.quantity} × ${item.price} = ${subtotal} جنيه\n`;
        message += "-------------------\n";
      });
      message += `\nالإجمالي: ${total} جنيه\n\n`;
      message += "اكتب *اطلب* لتأكيد الطلب ✅";

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
    
    // Save cart to Redis
    const cartKey = `cart:${shop.id}:${customerPhone}`;
    await redis.set(cartKey, JSON.stringify(cart), { ex: 3600 });
    
    // Show cart summary and ask if they want more items (using askForMoreItems format)
    const total = cart.reduce((s, i) => s + i.price * i.quantity, 0);
    
    let message = `🛒 سلة التسوق:\n\n`;
    cart.forEach((item, i) => {
      message += `${i + 1}. ${item.name}${item.variantInfo ? ` (${item.variantInfo})` : ''}\n`;
      message += `   الكمية: ${item.quantity} × ${item.price} = ${item.price * item.quantity} جنيه\n\n`;
    });
    message += `💰 الإجمالي: ${total} جنيه\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `هل ترغب في إضافة شيء آخر؟ 🤔\n\n`;
    message += `👍 اكتب "نعم" إذا كنت ترغب في إضافة منتج آخر\n`;
    message += `✅ اكتب "لا" إذا كان هذا كل شيء وترغب في إكمال الطلب`;
    
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
        'مش شغال', 'بطل', 'خراب', 'زهق', 'عصب', 'غضبان', 'متضايق', 
        'مش فاهم', 'مش بيشتغل', 'وحش', 'سيئ', 'باظ', 'تعبت', 'زهقت',
        'مش عارف', 'ليه كدا', 'لا يعني', 'معقول', 'يعني إيه', 'مش تمام',
        'في إيه مش', 'مش شايف', 'مخنوق', 'مستفز', 'زفت', 'هبل',
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
      // Common spelling mistakes
      .replace(/ق/g, 'ك')         // Qaf to kaf (common in dialect)
      .replace(/ث/g, 'س')         // Tha to seen
      .replace(/ذ/g, 'ز')         // Dhal to zay
      .replace(/ظ/g, 'ض')         // Dha to dad
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

  // Fuzzy match with spelling tolerance
  fuzzyMatch(text, pattern, threshold = 0.7) {
    const normalizedText = this.normalizeText(text);
    const normalizedPattern = this.normalizeText(pattern);
    
    // Exact match after normalization
    if (normalizedText.includes(normalizedPattern)) return true;
    
    // Word-by-word fuzzy match
    const textWords = normalizedText.split(' ');
    const patternWords = normalizedPattern.split(' ');
    
    for (const patternWord of patternWords) {
      if (patternWord.length < 2) continue; // Skip single chars
      
      for (const textWord of textWords) {
        // Check for substring match first
        if (textWord.includes(patternWord) || patternWord.includes(textWord)) {
          return true;
        }
        
        // Check similarity for similar length words
        if (Math.abs(textWord.length - patternWord.length) <= 2) {
          const similarity = this.calculateSimilarity(textWord, patternWord);
          if (similarity >= threshold) return true;
        }
      }
    }
    
    return false;
  }

  // Enhanced matchesIntent with spelling mistake tolerance
  matchesIntent(text, intent) {
    const patterns = {
      greeting: [
        'مرحبا', 'سلام', 'اهلا', 'هلا', 'صباح', 'مساء', 'هاي', 'hello', 'hi', 
        'السلام', 'كيف حالك', 'أخبارك', 'حياك', 'أهلين', 'هلا والله', 'عامل ايه', 'ازيك', 'إيه الأخبار', 'الأخبار إيه',
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
        // Misspellings
        'قايمه', 'قائمةة', 'منيوو', 'قايمةة', 'قائمه'
      ],
      cart: [
        'كارت', 'cart', 'سلة', 'السلة', 'الكارت', 'طلبي', 'اوردر',
        // Misspellings
        'كاررت', 'كارتت', 'سله', 'سلةة', 'طلبيي'
      ],
      order: [
        'اطلب', 'order', 'اطلب', 'احجز', 'booking', 'حجز',
        // Misspellings
        'اطلبب', 'اطللب', 'احجزز', 'حجزز'
      ],
      yes: [
        'نعم', 'ايوه', 'yes', 'أيوه', 'أيوة', 'ايوة', 'اوكي', 'حسنا', 'حسناً', 'ok', 'okay',
        // Misspellings
        'نعما', 'ايووه', 'ايوهه', 'أيووه', 'اوكيي', 'حسناا'
      ],
      no: [
        'لا', 'no', 'لأ', 'لأ', 'ليس', 'لا أريد', 'لا أحب',
        // Misspellings
        'لأأ', 'لاا', 'ليسس'
      ],
      cancel: [
        'الغاء', 'cancel', 'stop', 'لا أريد', 'غير', 'ما أريد', 'لا أحب',
        'الفاء', 'إلغاء', 'الغي', 'إلغي', 'امسح', 'لا عادي', 'مش عايز', 'بطل', 'اوقف', 'إيقاف', 'مسح', 'احذف', 'حذف', 'صفر',
        // Misspellings
        'الغا', 'الغاءء', 'كانسل', 'cancle', 'الغيي', 'امسحح', 'حذفف', 'امساح', 'الغاء الطلب', 'إلغاء الطلب', 'الغي الطلب'
      ],
      thanks: [
        'شكرا', 'thank', 'merci', 'تسلم', 'دومت', 'شكر', 'شكراً', 'thanks', 'thx',
        'مشكور', 'جزاك الله', 'بارك الله',
        // Misspellings
        'شكرر', 'شكراا', 'شكرراً', 'تسلمم'
      ],
      address: [
        'عنوان', 'address', 'موقع', 'مكان', 'loc',
        // Misspellings
        'عنوانن', 'عنوان', 'عنواان'
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
      
      let message = `🛒 سلة التسوق:\n\n`;
      items.forEach((item, i) => {
        message += `${i + 1}. ${item.name}\n`;
        message += `   الكمية: ${item.quantity} × ${item.price} = ${item.price * item.quantity} جنيه\n\n`;
      });
      message += `💰 الإجمالي: ${total} جنيه\n\n`;
      message += `━━━━━━━━━━━━━━━━━━━━━\n\n`;
      message += `هل ترغب في إضافة شيء آخر؟ 🤔\n\n`;
      message += `👍 اكتب "نعم" إذا كنت ترغب في إضافة منتج آخر\n`;
      message += `✅ اكتب "لا" إذا كان هذا كل شيء وترغب في إكمال الطلب`;
      
      // Set state for tracking
      await redis.set(`order_state:${shopId}:${customerPhone}`, 'waiting_for_more', { ex: 300 });
      
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
      // Store name
      await redis.set(`customer_name:${shopId}:${customerPhone}`, name, { ex: 600 });
      
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
                `📋 "قائمة" - عرض جميع المنتجات\n` +
                `🛒 "كارت" - عرض طلبك\n` +
                `✅ "اطلب" - تأكيد الطلب\n` +
                `👍 "نعم" - إضافة منتج آخر\n` +
                `👎 "لا" - إكمال الطلب\n` +
                `❌ "الغاء" - تفريغ السلة\n\n` +
                `💡 أو اكتب رقم المنتج مباشرة (1, 2, 3...)`;
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

        await sock.sendMessage(from, {
          text: `لإضافة *${product.name}* إلى سلتك،\n` +
                `يرجى اختيار:\n\n` +
                variantGroups.map(g =>
                  `*${g.name}:*\n` +
                  g.options.map(o => `• ${o}`).join('\n')
                ).join('\n\n') +
                `\n\nأرسل اختياراتك مثال:\n` +
                variantGroups.map(g =>
                  `${g.name}: ${g.options[0]}` 
                ).join('\n') +
                `\n\nأو اكتب *إلغاء* للرجوع` 
        })
        return
      }
    }

    // Add to cart
    const cartKey = `cart:${shop.id}:${customerPhone}` 
    const cartData = await redis.get(cartKey)
    const cart = cartData ? JSON.parse(cartData) : []

    const cartItemKey = variantInfo
      ? `${product.id}__${variantInfo}` 
      : product.id

    const existingIndex = cart.findIndex(
      i => i.cartItemKey === cartItemKey
    )

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
    this.invalidateShopCache(shop.id)

    const total = cart.reduce((s, i) => s + i.price * i.quantity, 0)
    const variantText = variantInfo ? ` (${variantInfo})` : ''

    await sock.sendMessage(from, {
      text: `تمت إضافة *${product.name}*${variantText} ✅\n` +
            `إجمالي سلتك: ${total} جنيه\n\n` +
            `اكتب *قائمة* لإضافة المزيد\n` +
            `أو *اطلب* لتأكيد طلبك` 
    })
  }

  async reduceStock(cart, shop, sock) {
    for (const item of cart) {
      try {
        const product = await prisma.product.findUnique({
          where: { id: item.productId }
        })

        if (!product) continue
        if (product.stock === null ||
            product.stock === undefined) continue

        const newStock = Math.max(0, product.stock - item.quantity)

        await prisma.product.update({
          where: { id: item.productId },
          data: {
            stock: newStock,
            isAvailable: newStock > 0
          }
        })

        this.invalidateShopCache(shop.id)

        if (newStock > 0 && newStock <= 3) {
          await sock.sendMessage(
            `${shop.whatsappNumber}@s.whatsapp.net`,
            {
              text: `⚠️ *تنبيه: كمية منخفضة*\n` +
                    `المنتج: *${product.name}*\n` +
                    `الكمية المتبقية: ${newStock} فقط` 
            }
          )
        }

        if (newStock === 0) {
          await sock.sendMessage(
            `${shop.whatsappNumber}@s.whatsapp.net`,
            {
              text: `🔴 *تنبيه: نفذت الكمية*\n` +
                    `المنتج: *${product.name}* نفذ بالكامل` 
            }
          )
        }

      } catch (err) {
        console.error('Stock reduce error:', err)
      }
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
