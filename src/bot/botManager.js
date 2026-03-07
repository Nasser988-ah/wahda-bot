const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const path = require("path");
const fs = require("fs");
const databaseService = require("../services/databaseService");
const redis = require("../db/redis");
const { HfInference } = require("@huggingface/inference");

const HF_TOKEN = process.env.HUGGINGFACE_TOKEN;
const hf = HF_TOKEN ? new HfInference(HF_TOKEN) : null;

const prisma = databaseService.getClient();

class BotManager {
  constructor() {
    this.connections = new Map();
    this.qrCallbacks = new Map();
    this.connectionStates = new Map();
    this.qrReceived = new Map();
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

      // Get shop info
      const shop = await prisma.shop.findUnique({
        where: { id: shopId },
        include: { products: true }
      });

      if (!shop) throw new Error("Shop not found");

      // Mark as connecting
      this.connectionStates.set(shopId, 'connecting');
      this.qrReceived.set(shopId, false);

      // Setup session directory
      const sessionDir = path.resolve(`./sessions/${shopId}`);
      
      // Only clear session for fresh connections, not reconnects after QR scan
      const isReconnect = this.qrCallbacks.has(shopId);
      if (!isReconnect && fs.existsSync(sessionDir)) {
        try {
          fs.rmSync(sessionDir, { recursive: true, force: true });
          console.log(`🧹 Cleared existing session for ${shop.name}`);
        } catch (e) {
          console.log(`⚠️ Could not clear session: ${e.message}`);
        }
      }
      
      // Create session directory
      fs.mkdirSync(sessionDir, { recursive: true });

      // Initialize auth state
      const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

      // Create socket with proper configuration for QR generation
      const sock = makeWASocket({
        auth: state,
        logger: pino({ level: "silent" }),
        printQRInTerminal: false,
        keepAliveIntervalMs: 30000,
        connectTimeoutMs: 60000,
        qrTimeout: 40000,
        shouldIgnoreJid: () => false,
        shouldSyncHistoryMessage: () => false,
      });

      // Store connection
      this.connections.set(shopId, sock);
      this.qrCallbacks.set(shopId, qrCallback);

      // Handle credentials update
      sock.ev.on('creds.update', saveCreds);

      // Handle connection updates
      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // Handle QR code
        if (qr && qrCallback && !this.qrReceived.get(shopId)) {
          console.log(`📱 QR received for ${shop.name}`);
          this.qrReceived.set(shopId, true);
          qrCallback(qr);
        }

        // Handle successful connection
        if (connection === 'open') {
          console.log(`✅ ${shop.name} connected successfully!`);
          console.log(`📊 Connection state for ${shopId}: ${connection}`);
          this.connectionStates.set(shopId, 'connected');
          // Verify state was set
          console.log(`📊 Verified state: ${this.connectionStates.get(shopId)}`);
        }

        // Handle connection close
        if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          console.log(`🔌 ${shop.name} disconnected. Code: ${statusCode}`);
          
          // Clean up
          this.connections.delete(shopId);
          
          if (statusCode === DisconnectReason.loggedOut) {
            // Clear session on logout
            try {
              fs.rmSync(sessionDir, { recursive: true, force: true });
            } catch (e) {}
            this.connectionStates.set(shopId, 'not_started');
            this.qrCallbacks.delete(shopId);
            console.log('🗑️ Session cleared after logout');
          } else if (statusCode === 405) {
            // 405 = needs QR scan - DON'T delete callback, keep it for retry
            console.log(`⏳ Not logged in (405) - will retry`);
            this.connectionStates.set(shopId, 'not_started');
            // Note: we keep the qrCallback so the next attempt can use it
          } else if (statusCode === 515) {
            // 515 = Restart Required (normal after QR scan)
            // The session is now authenticated, need to reconnect to complete
            console.log(`🔄 Restart required (515) - QR scanned, reconnecting...`);
            this.connectionStates.set(shopId, 'reconnecting');
            
            // Wait 3 seconds then reconnect with saved credentials
            setTimeout(() => {
              console.log(`🔄 Auto-reconnecting after QR scan...`);
              this.connectShop(shopId, qrCallback).then(() => {
                // Set a timeout to check if connection actually opened
                setTimeout(() => {
                  if (this.connectionStates.get(shopId) === 'connecting') {
                    console.log(`⚠️ Connection stuck in connecting state, forcing status check...`);
                    // Force check if we're actually connected
                    const sock = this.connections.get(shopId);
                    if (sock && sock.user) {
                      console.log(`✅ Socket has user, marking as connected`);
                      this.connectionStates.set(shopId, 'connected');
                    }
                  }
                }, 5000);
              }).catch(err => {
                console.log(`⚠️ Auto-reconnect failed: ${err.message}`);
              });
            }, 3000);
          } else {
            // Other errors
            this.connectionStates.set(shopId, 'disconnected');
            this.qrCallbacks.delete(shopId);
          }
        }
      });

      // Handle messages
      sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const msg = messages[0];
        if (!msg?.message || msg.key.fromMe) return;
        
        await this.handleMessage(sock, msg, shop);
      });

      console.log(`🤖 Connection initialized for ${shop.name}`);
      return sock;

    } catch (error) {
      console.error(`❌ Connection error for ${shopId}:`, error.message);
      this.connectionStates.set(shopId, 'not_started');
      throw error;
    }
  }

  async handleMessage(sock, msg, shop) {
    try {
      const from = msg.key.remoteJid;
      const customerPhone = from.split('@')[0];
      
      // Extract text
      const text = msg.message?.conversation || 
                   msg.message?.extendedTextMessage?.text || 
                   msg.message?.imageMessage?.caption || 
                   msg.message?.videoMessage?.caption || '';

      if (!text.trim()) return;

      console.log(`📩 ${shop.name} - Message from ${customerPhone}: "${text}"`);

      const lowerText = text.toLowerCase().trim();

      // Check for order states first - handle name/phone/address collection
      const orderState = await redis.get(`order_state:${shopId}:${customerPhone}`);
      
      if (orderState === 'waiting_for_name') {
        // User is providing their name
        await this.handleNameInput(sock, from, shopId, customerPhone, shop, text.trim());
        return;
      } else if (orderState === 'waiting_for_phone') {
        // Check if it's a valid Egyptian phone number
        const phone = text.replace(/\s/g, '');
        if (/^0?1\d{9}$/.test(phone)) {
          await this.handlePhoneInput(sock, from, shopId, customerPhone, shop, phone);
        } else {
          await this.safeSendMessage(sock, from, "❌ رقم تليفون مش صحيح. جرب تاني بالشكل ده: 01012345678", shop.name);
        }
        return;
      } else if (orderState === 'waiting_for_address' || lowerText.startsWith('عنوان:') || lowerText.startsWith('العنوان:')) {
        await this.handleAddressInput(sock, from, shopId, customerPhone, shop, text);
        return;
      }

      // Handle text commands first - NO greeting prefix for commands
      if (lowerText === 'قائمة' || lowerText === 'menu') {
        await this.sendProductsList(sock, from, shop, customerPhone, 1);
      } else if (lowerText === 'كارت' || lowerText === 'cart') {
        await this.showCart(sock, from, shop.id, customerPhone, shop);
      } else if (lowerText === 'اطلب' || lowerText === 'order') {
        await this.askForMoreItems(sock, from, shop.id, customerPhone, shop);
      } else if (lowerText === 'لا' || lowerText === 'no' || lowerText === 'تمام') {
        // Always collect customer details before confirming
        const cartKey = `cart:${shopId}:${customerPhone}`;
        let cart = await redis.get(cartKey);
        let items = [];
        if (cart) {
          try {
            items = typeof cart === 'string' ? JSON.parse(cart) : cart;
          } catch (e) { items = []; }
        }
        
        if (items.length === 0) {
          await this.safeSendMessage(sock, from, "🛒 السلة فاضية! اكتب \"قائمة\" الأول.", shop.name);
        } else {
          // Always ask for phone/address before confirming
          await this.askForCustomerDetails(sock, from, shopId, customerPhone, shop);
        }
      } else if (lowerText === 'ايوه' || lowerText === 'yes' || lowerText === 'أيوه') {
        await this.safeSendMessage(sock, from, `عظمة! 👏\n\nاكتب رقم المنتج اللي عايزه أو اكتب "قائمة" لو عايز تشوف القائمة.`, shop.name);
      } else if (lowerText.startsWith('عنوان:') || lowerText.startsWith('العنوان:') || lowerText.startsWith('address:')) {
        // User is providing address
        await this.handleAddressInput(sock, from, shopId, customerPhone, shop, text);
      } else if (/^0?1\d{9}$/.test(text.replace(/\s/g, ''))) {
        // Egyptian phone number format
        await this.handlePhoneInput(sock, from, shopId, customerPhone, shop, text.replace(/\s/g, ''));
      } else if (lowerText.startsWith('صفحة ') || lowerText.startsWith('page ')) {
        const pageNum = parseInt(text.split(' ')[1]) || 1;
        await this.sendProductsList(sock, from, shop, customerPhone, pageNum);
      } else if (lowerText === 'الغاء' || lowerText === 'cancel') {
        await this.clearCart(sock, from, shop.id, customerPhone, shop.name);
      } else if (lowerText === 'مساعدة' || lowerText === 'help') {
        await this.sendHelpMessage(sock, from, shop);
      } else if (/^\d+$/.test(text)) {
        // ANY number adds product to cart (no conflict with commands)
        await this.addToCart(sock, from, shop.id, customerPhone, parseInt(text), shop);
      } else {
        // Try AI/smart response - add greeting only for unknown/fallback messages
        const aiResponse = await this.getAIResponse(text, shop);
        if (aiResponse) {
          await this.safeSendMessage(sock, from, aiResponse, shop.name);
        } else {
          // Only for completely unknown input, show greeting + menu
          const greeting = `👋 أهلاً بيك في ${shop.name}!\n\n`;
          await this.sendNumberedMenu(sock, from, shop, greeting);
        }
      }

    } catch (error) {
      console.error(`❌ Error handling message:`, error.message);
    }
  }

  async safeSendMessage(sock, to, message, shopName) {
    try {
      const result = await sock.sendMessage(to, { text: message });
      console.log(`✅ Message sent to ${to}`);
      return result;
    } catch (error) {
      console.error(`❌ Failed to send message to ${to}:`, error.message);
      return null;
    }
  }

  async sendProductsList(sock, from, shop, customerPhone, page = 1) {
    const availableProducts = shop.products.filter(p => p.isAvailable);
    
    if (availableProducts.length === 0) {
      await this.safeSendMessage(sock, from, "مفيش منتجات متاحة دلوقتي.\n\nتواصل معنا مباشرة على التليفون.", shop.name);
      return;
    }

    const ITEMS_PER_PAGE = 10;
    const totalPages = Math.ceil(availableProducts.length / ITEMS_PER_PAGE);
    
    // Validate page number
    if (page < 1) page = 1;
    if (page > totalPages) page = totalPages;
    
    const startIndex = (page - 1) * ITEMS_PER_PAGE;
    const endIndex = startIndex + ITEMS_PER_PAGE;
    const pageProducts = availableProducts.slice(startIndex, endIndex);

    let message = `📦 منتجات ${shop.name} - صفحة ${page} من ${totalPages}\n\n`;
    message += `━━━━━━━━━━━━━━━━━━━━━\n\n`;
    
    pageProducts.forEach((p, i) => {
      const itemNumber = startIndex + i + 1;
      message += `${itemNumber}. ${p.name}\n`;
      message += `💰 السعر: ${p.price} جنيه\n`;
      if (p.description) {
        message += `📝 ${p.description}\n`;
      }
      message += `\n`;
    });
    
    message += `━━━━━━━━━━━━━━━━━━━━━\n\n`;
    message += `💡 عشان تطلب:\n`;
    message += `اكتب رقم المنتج (مثلا: ${startIndex + 1})\n\n`;
    
    if (totalPages > 1) {
      if (page < totalPages) {
        message += `📄 اكتب "صفحة ${page + 1}" للصفحة الجاية\n`;
      }
      if (page > 1) {
        message += `📄 اكتب "صفحة ${page - 1}" للصفحة اللي فاتت\n`;
      }
    }
    
    await this.safeSendMessage(sock, from, message, shop.name);
  }

  async addToCart(sock, from, shopId, customerPhone, productNum, shop) {
    try {
      const products = shop.products.filter(p => p.isAvailable);
      const product = products[productNum - 1];
      
      if (!product) {
        await this.safeSendMessage(sock, from, "❌ رقم منتج غير صحيح. أرسل قائمة لعرض المنتجات المتاحة.", shop.name);
        return;
      }

      const cartKey = `cart:${shopId}:${customerPhone}`;
      let cart;
      try {
        cart = await redis.get(cartKey);
        console.log(`🛒 Cart data for ${customerPhone}:`, cart);
      } catch (e) {
        console.log(`⚠️ Redis error: ${e.message}`);
        cart = null;
      }
      
      let items = [];
      if (cart) {
        try {
          // Handle both string and object responses
          if (typeof cart === 'string') {
            items = JSON.parse(cart);
          } else if (typeof cart === 'object') {
            items = cart;
          }
        } catch (e) {
          console.log(`⚠️ JSON parse error, resetting cart: ${e.message}`);
          items = [];
        }
      }
      
      const existing = items.find(i => i.productId === product.id);
      if (existing) {
        existing.quantity++;
      } else {
        items.push({ productId: product.id, name: product.name, price: product.price, quantity: 1 });
      }
      
      await redis.set(cartKey, JSON.stringify(items), { ex: 3600 });
      
      // Calculate total items in cart
      const totalItems = items.reduce((sum, i) => sum + i.quantity, 0);
      
      await this.safeSendMessage(sock, from, 
        `تمت إضافة ${product.name} للسلة ✅\n\n` +
        `الآن عندك ${totalItems} منتج في السلة\n\n` +
        `اكتب *كارت* لتشوف طلبك\n` +
        `اكتب *اطلب* لتأكيد الطلب`, shop.name);
      
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
        await this.safeSendMessage(sock, from, "🛒 السلة فارغة.", shop.name);
        return;
      }

      let message = `سلة التسوق:\n\n`;
      let total = 0;
      items.forEach((item, i) => {
        const subtotal = item.price * item.quantity;
        total += subtotal;
        message += `${i + 1}. ${item.name}\n`;
        message += `الكمية: ${item.quantity}\n`;
        message += `السعر: ${subtotal} جنيه\n`;
        message += "-------------------\n";
      });
      message += `\nالإجمالي: ${total} جنيه\n\n`;
      message += "اكتب *اطلب* لتأكيد الطلب";

      await this.safeSendMessage(sock, from, message, shop.name);
    } catch (error) {
      console.error(`❌ Error in showCart:`, error);
      await this.safeSendMessage(sock, from, "❌ حدث خطأ. يرجى المحاولة مرة أخرى.", shop.name);
    }
  }

  async clearCart(sock, from, shopId, customerPhone, shopName) {
    const cartKey = `cart:${shopId}:${customerPhone}`;
    await redis.del(cartKey);
    await this.safeSendMessage(sock, from, "🗑️ تم تفريغ السلة.", shopName);
  }

  async confirmOrder(sock, from, shopId, customerPhone, shop) {
    // This is the OLD method - redirect to details collection
    await this.askForCustomerDetails(sock, from, shopId, customerPhone, shop);
  }

  async getAIResponse(text, shop) {
    try {
      // If no HF token, use smart rule-based responses
      if (!hf) {
        return this.getSmartResponse(text, shop);
      }

      // Use Hugging Face for AI responses
      const prompt = `You are a friendly Egyptian Arabic WhatsApp bot for ${shop.name}. 
User message: "${text}"
Respond naturally in Egyptian Arabic (like "يا فندم", "عظمة", "ماشي", "تمام"). Keep it short (1-2 sentences) and friendly.
If asking about products, tell them to type "قائمة".
If asking about prices, tell them to check the product list.
If greeting, be welcoming and mention the shop name.`;

      const response = await hf.textGeneration({
        model: 'google/flan-t5-base',
        inputs: prompt,
        parameters: { max_new_tokens: 100, temperature: 0.7 }
      });

      return response.generated_text;
    } catch (error) {
      console.log('AI fallback to rule-based:', error.message);
      return this.getSmartResponse(text, shop);
    }
  }

  getSmartResponse(text, shop) {
    const lowerText = text.toLowerCase();
    
    // Smart intent detection with more keywords
    const intents = {
      greeting: ['مرحبا', 'سلام', 'اهلا', 'هلا', 'صباح', 'مساء', 'هاي', 'hello', 'hi', 'السلام', 'السلام عليكم', 'عليكم', 'ازيك', 'اخبارك', 'كيف حالك'],
      price: ['سعر', 'بكم', 'كام', 'price', 'cost', 'فلوس', 'جنيه', 'بكام', 'قيمة', 'فلوس', 'تكلفة'],
      order: ['اطلب', 'order', 'شراء', 'اشتري', 'حاجز', 'احجز', ' book', 'حجز', 'ابغى', 'ابغي', 'عايز', 'عاوز', 'نفسي في'],
      products: ['منتج', 'عندك', 'products', 'items', 'حاجات', 'اكل', 'مشروبات', 'عندكم', 'شو عندكم', 'شو عندك', 'ايش عندكم'],
      help: ['مساعدة', 'help', 'ازاي', 'كيف', 'شلون', 'ازي', 'كيف', 'كيفك', 'مساعده', 'ساعدني'],
      location: ['فين', 'مكان', 'location', 'address', 'عنوان', 'وين', 'المكان', 'الموقع'],
      time: ['ساعة', 'وقت', 'time', 'امتى', 'متى', 'دقيقة', 'متي', 'الوقت', 'الساعه', 'الساعة'],
      cancel: ['الغاء', 'cancel', 'stop', 'مش عايز', 'غير', 'ما ابغى', 'لا ابغى', 'مش عاوز', 'مش عايز'],
      thanks: ['شكرا', 'thank', 'merci', 'تسلم', 'دومت', 'شكر', 'شكراً', 'thanks', 'thx'],
      goodbye: ['مع السلامة', 'باي', 'bye', 'معسلامه', 'الى اللقاء', 'بشوفك', 'اشوفك', 'نشوفك'],
      joke: ['نكتة', 'نكته', ' joke', 'ضحك', 'هظحك', 'فرفش', 'فرشني'],
      hours: ['ساعات العمل', 'متى تفتحون', 'متى تفتحو', 'مواعيد', 'مواعيد العمل', 'افتح', 'افتحو', 'مفتوحين'],
    };

    // Find matching intent
    for (const [intent, keywords] of Object.entries(intents)) {
      if (keywords.some(k => lowerText.includes(k))) {
        const responses = {
          greeting: `أهلاً بيك يا فندم في ${shop.name}! 😊\n\nعايز تشوف منتجاتنا؟ اكتب "قائمة"`,
          price: `الأسعار عندنا حلوة يا فندم! �\n\nاكتب "قائمة" تشوف كل المنتجات مع أسعارها`,
          order: `عظمة! 👏\n\nاكتب "قائمة" تشوف المنتجات، ثم اكتب رقم المنتج اللي عايزه`,
          products: `عندنا منتجات لذيذة ومميزة! 🤤\n\nاكتب "قائمة" تشوف كل اللي عندنا`,
          help: `أقدر أساعدك يا فندم! 💪\n\n📋 "قائمة" - تشوف المنتجات\n🛒 "كارت" - تشوف طلبك\n✅ "اطلب" - تطلب`,
          location: `📍 ${shop.name} موجودة وبتخدمك بأحسن جودة!\n\nاكتب "قائمة" تشوف المنتجات المتاحة`,
          time: `⏰ بنعمل دليفري سريع جداً!\n\nاكتب "اطلب" ونوصلك في أسرع وقت`,
          cancel: `ماشي يا فندم، لو غيرت رأيك اكتب "قائمة" في أي وقت 😊`,
          thanks: `العفو يا فندم! 🙏\n\nفي خدمتك دايماً! اكتب "قائمة" لو عايز حاجة`,
          goodbye: `مع السلامة يا فندم! 👋\n\nنورتنا! ارجع في أي وقت تحب.`,
          joke: `😂 لو عايز نكتة، اطلب من صاحبك!\n\nأنا بوت شغال مش بوت فرفوش 😜\n\nاكتب "قائمة" لو عايز تشوف منتجاتنا!`,
          hours: `⏰ بنشتغل يومياً!\n\nاكتب "قائمة" تشوف المنتجات المتاحة دلوقتي`,
        };
        return responses[intent] || null;
      }
    }

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
        await this.safeSendMessage(sock, from, "السلة فاضية يا فندم! 😅\n\nاكتب \"قائمة\" الأول واختار منتج.", shop.name);
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
      message += `عايز تضيف حاجة تانية؟ 🤔\n\n`;
      message += `👍 اكتب "ايوه" لو عايز تضيف منتج تاني\n`;
      message += `✅ اكتب "لا" لو كده تمام وعايز تكمل الطلب`;
      
      // Set state for tracking
      await redis.set(`order_state:${shopId}:${customerPhone}`, 'waiting_for_more', { ex: 300 });
      
      await this.safeSendMessage(sock, from, message, shop.name);
      
    } catch (error) {
      console.error(`❌ Error in askForMoreItems:`, error);
      await this.safeSendMessage(sock, from, "حصل مشكلة صغيرة! جرب تاني.", shop.name);
    }
  }

  async askForCustomerDetails(sock, from, shopId, customerPhone, shop) {
    try {
      // Set state to waiting for name first
      await redis.set(`order_state:${shopId}:${customerPhone}`, 'waiting_for_name', { ex: 600 });
      
      await this.safeSendMessage(sock, from, 
        `عشان نتوصل معاك ونوصل الطلب، محتاج بياناتك 📝\n\n` +
        `اكتب اسمك الأول:`, shop.name);
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
        `تمام يا ${name}! ✅\n\n` +
        `دلوقتي محتاج رقم تليفونك 📱\n` +
        `اكتب رقمك بالشكل ده: 01012345678`, shop.name);
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
        `تمام! رقمك: ${phone} ✅\n\n` +
        `دلوقتي محتاج عنوان التوصيل 🏠\n\n` +
        `اكتب العنوان بالشكل ده:\n` +
        `عنوان: شارع التحرير، مدينة نصر، القاهرة\n\n` +
        `أو أي تفاصيل توصلك بيها`, shop.name);
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
        await this.safeSendMessage(sock, from, "❌ السلة فارغة. أرسل قائمة لعرض المنتجات.", shop.name);
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
              price: i.price
            }))
          }
        }
      });

      let msg = `🎉 تم تأكيد طلبك رقم ${order.id.slice(-8)} ✅\n\n`;
      msg += `📱 رقم التليفون: ${customerPhoneNumber}\n`;
      msg += `📍 عنوان التوصيل: ${customerAddress}\n\n`;
      msg += `🛒 تفاصيل الطلب:\n`;
      items.forEach((i, idx) => {
        msg += `${idx + 1}. ${i.name} × ${i.quantity} = ${i.price * i.quantity} جنيه\n`;
      });
      msg += `\n💰 المجموع الكلي: ${total} جنيه\n\n`;
      msg += `⏰ هنتوصل معاك خلال شوية لتأكيد التوصيل\n`;
      msg += `شكراً لاختيارك ${shop.name}! 🙏`;

      await this.safeSendMessage(sock, from, msg, shop.name);
      
      // Clear cart and temp data
      await redis.del(cartKey);
      await redis.del(`customer_name:${shopId}:${customerPhone}`);
      await redis.del(`customer_phone:${shopId}:${customerPhone}`);
      await redis.del(`customer_address:${shopId}:${customerPhone}`);

      // Notify owner
      if (shop.whatsappNumber) {
        const ownerMsg = `🔔 طلب جديد من ${shop.name}\n\n` +
                        `رقم الطلب: ${order.id.slice(-8)}\n` +
                        `العميل: ${customerName}\n` +
                        `📱 ${customerPhoneNumber}\n` +
                        `📍 ${customerAddress}\n` +
                        `💰 المبلغ: ${total} جنيه\n` +
                        `🛒 عدد المنتجات: ${items.length}\n\n` +
                        `افحص لوحة التحكم للتفاصيل.`;
        
        await this.safeSendMessage(sock, `${shop.whatsappNumber}@s.whatsapp.net`, ownerMsg, shop.name);
      }

    } catch (error) {
      console.error(`❌ Error in confirmOrderWithDetails:`, error);
      await this.safeSendMessage(sock, from, "❌ حدث خطأ أثناء تأكيد الطلب. جرب تاني.", shop.name);
    }
  }

  async sendNumberedMenu(sock, from, shop, greetingPrefix = '') {
    const menu = greetingPrefix +
                 `✨ إزاي أقدر أساعدك؟\n\n` +
                 `📋 اكتب "قائمة" - عرض المنتجات\n` +
                 `🛒 اكتب "كارت" - تشوف طلبك\n` +
                 `✅ اكتب "اطلب" - اطلب دلوقتي\n` +
                 `❓ اكتب "مساعدة" - للمساعدة\n\n` +
                 `💡 اكتب أي رقم (1, 2, 3...) لإضافة منتج للسلة`;
    await this.safeSendMessage(sock, from, menu, shop.name);
  }

  async sendHelpMessage(sock, from, shop) {
    const msg = `👋 أهلاً بيك في ${shop.name}!\n\n` +
                `📱 الأوامر المتاحة:\n\n` +
                `📋 "قائمة" - عرض كل المنتجات\n` +
                `🛒 "كارت" - تشوف طلبك\n` +
                `✅ "اطلب" - تأكيد الطلب\n` +
                `👍 "ايوه" - أضف منتج تاني\n` +
                `👎 "لا" - كده تمام واطلب\n` +
                `❌ "الغاء" - فضي السلة\n\n` +
                `💡 اكتب رقم المنتج مباشرة (1, 2, 3...) لإضافته للسلة`;
    await this.safeSendMessage(sock, from, msg, shop.name);
  }

  async sendEgyptianResponse(sock, from, text, shop) {
    const lowerText = text.toLowerCase();
    
    // Egyptian style responses - NO confusing numbered options
    if (lowerText.includes('مرحبا') || lowerText.includes('سلام') || lowerText.includes('اهلا') || lowerText.includes('هلا')) {
      await this.safeSendMessage(sock, from, `أهلاً بيك يا فندم في ${shop.name}! 😊\n\nاكتب "قائمة" تشوف منتجاتنا.`, shop.name);
    } else if (lowerText.includes('مين') || lowerText.includes('who') || lowerText.includes('انت مين')) {
      await this.safeSendMessage(sock, from, `أنا بوت ${shop.name} يا فندم! 🤖\n\nاكتب "مساعدة" عشان تعرف الأوامر.`, shop.name);
    } else if (lowerText.includes('سعر') || lowerText.includes('بكم') || lowerText.includes('كام') || lowerText.includes('price')) {
      await this.safeSendMessage(sock, from, `الأسعار مختلفة يا فندم! 💰\n\nاكتب "قائمة" تشوف كل المنتجات مع أسعارها.`, shop.name);
    } else if (lowerText.includes('طلب') || lowerText.includes('order')) {
      await this.safeSendMessage(sock, from, `عشان تطلب سهل جداً يا فندم! 👍\n\nاكتب "قائمة" تشوف المنتجات\nاختار رقم المنتج اللي عايزه\nاكتب "اطلب" لتأكيد الطلب`, shop.name);
    } else if (lowerText.includes('منتج') || lowerText.includes('عندك') || lowerText.includes('products')) {
      await this.safeSendMessage(sock, from, `عندنا منتجات كتيرة ومميزة! 🤩\n\nاكتب "قائمة" تشوف كل اللي عندنا.`, shop.name);
    } else if (lowerText.includes('مساعدة') || lowerText.includes('help')) {
      await this.sendHelpMessage(sock, from, shop);
    } else if (lowerText.includes('شكرا') || lowerText.includes('thank')) {
      await this.safeSendMessage(sock, from, `العفو يا فندم! 🙏\n\nفي خدمتك دايماً! اكتب "قائمة" لو عايز حاجة تانية.`, shop.name);
    } else {
      // Default - show menu with greeting only for unknown input
      const greeting = `👋 أهلاً بيك في ${shop.name}!\n\n`;
      await this.sendNumberedMenu(sock, from, shop, greeting);
    }
  }

  getConnectionState(shopId) {
    return this.connectionStates.get(shopId) || 'not_started';
  }

  isShopConnected(shopId) {
    return this.connectionStates.get(shopId) === 'connected';
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

module.exports = BotManager;
