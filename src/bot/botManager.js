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
const Groq = require("groq-sdk");

const HF_TOKEN = process.env.HUGGINGFACE_TOKEN;
const hf = HF_TOKEN ? new HfInference(HF_TOKEN) : null;

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const groq = GROQ_API_KEY ? new Groq({ apiKey: GROQ_API_KEY }) : null;

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

      // Get conversation context for smarter responses
      const context = await this.getConversationContext(shop.id, customerPhone);
      
      // Update message history for context awareness
      await this.updateMessageHistory(shop.id, customerPhone, text, 'user');

      // Check for order states first - handle name/phone/address collection
      const orderState = await redis.get(`order_state:${shop.id}:${customerPhone}`);
      
      if (orderState === 'waiting_for_name') {
        await this.handleNameInput(sock, from, shop.id, customerPhone, shop, text.trim());
        return;
      } else if (orderState === 'waiting_for_phone') {
        const phone = text.replace(/\s/g, '');
        if (/^0?1\d{9}$/.test(phone)) {
          await this.handlePhoneInput(sock, from, shop.id, customerPhone, shop, phone);
        } else {
          await this.safeSendMessage(sock, from, 
            `⚠️ يا فندم، الرقم ده مش صحيح \n\n` +
            `اكتب رقمك بالشكل الصحيح زي: 01012345678 📱`, shop.name);
        }
        return;
      } else if (orderState === 'waiting_for_address' || lowerText.startsWith('عنوان:') || lowerText.startsWith('العنوان:')) {
        await this.handleAddressInput(sock, from, shop.id, customerPhone, shop, text);
        return;
      }

      // Handle text commands with context awareness - using fuzzy matching for spelling tolerance
      if (this.matchesIntent(lowerText, 'menu')) {
        await this.sendProductsList(sock, from, shop, customerPhone, 1);
      } else if (this.matchesIntent(lowerText, 'cart')) {
        await this.showCart(sock, from, shop.id, customerPhone, shop);
      } else if (this.matchesIntent(lowerText, 'order')) {
        await this.askForMoreItems(sock, from, shop.id, customerPhone, shop);
      } else if (this.matchesIntent(lowerText, 'no')) {
        await this.handleNoResponse(sock, from, shop, customerPhone);
      } else if (this.matchesIntent(lowerText, 'yes')) {
        await this.handleYesResponse(sock, from, shop, customerPhone, context);
      } else if (lowerText.startsWith('عنوان:') || lowerText.startsWith('العنوان:') || lowerText.startsWith('address:')) {
        await this.handleAddressInput(sock, from, shop.id, customerPhone, shop, text);
      } else if (/^0?1\d{9}$/.test(text.replace(/\s/g, ''))) {
        await this.handlePhoneInput(sock, from, shop.id, customerPhone, shop, text.replace(/\s/g, ''));
      } else if (lowerText.startsWith('صفحة ') || lowerText.startsWith('page ')) {
        const pageNum = parseInt(text.split(' ')[1]) || 1;
        await this.sendProductsList(sock, from, shop, customerPhone, pageNum);
      } else if (this.matchesIntent(lowerText, 'cancel')) {
        await this.handleCancelCommand(sock, from, shop, customerPhone);
      } else if (this.matchesIntent(lowerText, 'help')) {
        await this.sendHelpMessage(sock, from, shop, context);
      } else if (/^\d+$/.test(text)) {
        await this.addToCart(sock, from, shop.id, customerPhone, parseInt(text), shop);
      } else {
        // Smart AI response with context
        await this.handleSmartResponse(sock, from, shop, customerPhone, text, context);
      }

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
          items = typeof cart === 'string' ? JSON.parse(cart) : cart;
        } catch (e) { items = []; }
      }
      
      const messages = history ? JSON.parse(history) : [];
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
      let messages = history ? JSON.parse(history) : [];
      
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
        `🛒 السلة فاضية يا فندم! \n\n` +
        `عايز تشوف منتجاتنا؟ اكتب "قائمة" واختار اللي يناسبك 😊`, shop.name);
    } else {
      const total = items.reduce((sum, i) => sum + i.price * i.quantity, 0);
      await this.safeSendMessage(sock, from,
        `💡 تمام يا فندم! عندك ${items.length} منتج في السلة بإجمالي ${total} جنيه\n\n` +
        `دلوقتي هنسجل بيانات التوصيل... 📝`, shop.name);
      await this.askForCustomerDetails(sock, from, shop.id, customerPhone, shop);
    }
  }

  // Handle "ايوه" response with smart suggestions
  async handleYesResponse(sock, from, shop, customerPhone, context) {
    const suggestions = context.hasItems 
      ? `ممتاز! 👌 عندك ${context.itemCount} منتجات في السلة\n\n`
      : `عظمة! 👏\n\n`;
    
    await this.safeSendMessage(sock, from, 
      suggestions + 
      `اكتب رقم المنتج اللي عايزه، أو اكتب "قائمة" لو عايز تشوف كل المنتجات 📋`, shop.name);
  }

  // Smart cancel with empathy
  async handleCancelCommand(sock, from, shop, customerPhone) {
    const cartKey = `cart:${shop.id}:${customerPhone}`;
    await redis.del(cartKey);
    await this.safeSendMessage(sock, from, 
      `🗑️ تمام يا فندم، فضيت السلة.\n\n` +
      `لو حابب تطلب حاجة تانية في أي وقت، اكتب "قائمة" وأنا تحت أمرك 😊`, shop.name);
  }

  // Smart response handler with emotional intelligence and Groq AI
  async handleSmartResponse(sock, from, shop, customerPhone, text, context) {
    // Detect emotion and intent
    const emotion = this.detectEmotion(text);
    const intent = this.detectAdvancedIntent(text);
    
    // Try Groq AI first for natural conversation
    const groqResponse = await this.getGroqResponse(text, shop, context, emotion, intent);
    if (groqResponse) {
      await this.safeSendMessage(sock, from, groqResponse, shop.name);
      await this.updateMessageHistory(shop.id, customerPhone, text, 'user', intent);
      await this.updateMessageHistory(shop.id, customerPhone, groqResponse, 'bot', 'groq_response');
      return;
    }
    
    // Fallback to rule-based human-like response
    const response = await this.getHumanLikeResponse(text, shop, context, emotion, intent);
    
    await this.safeSendMessage(sock, from, response, shop.name);
    await this.updateMessageHistory(shop.id, customerPhone, text, 'user', intent);
    await this.updateMessageHistory(shop.id, customerPhone, response, 'bot', 'response');
  }

  // Groq AI integration for smart natural responses
  async getGroqResponse(text, shop, context, emotion, intent) {
    if (!groq) {
      console.log('⚠️ Groq not configured, skipping AI response');
      return null;
    }

    try {
      // Get conversation history for context
      const historyKey = `chat_history:${shop.id}:${context.name || 'user'}`;
      const historyData = await redis.get(historyKey);
      const messages = historyData ? JSON.parse(historyData) : [];
      
      // Build conversation context for Groq
      const conversationHistory = messages.slice(-5).map(m => ({
        role: m.sender === 'user' ? 'user' : 'assistant',
        content: m.text
      }));

      // Create system prompt with shop context
      const systemPrompt = `أنت مساعد ذكي وودود لمحل ${shop.name}. 
المحل يبيع: ${shop.products?.filter(p => p.isAvailable).map(p => p.name).join(', ') || 'منتجات متنوعة'}.

قواعد الرد:
1. رد باللهجة المصرية العامية (زي "يا فندم", "عظمة", "تمام", "ماشي")
2. كون ودود ومحترف وإنساني
3. لو العميل عنده منتجات في السلة (${context.itemCount} منتجات)، شجعه يكمل الطلب
4. لو العميل جديد، رحب بيه وقوله اكتب "قائمة" 
5. لو العميل متضايق (${emotion}), طمنه وحل مشكلته
6. خلي الرد مختصر (2-3 جمل كحد أقصى)
7. استخدم إيموجي مناسبة
8. لو مش فاهم حاجة، قوله "ممكن توضح أكتر؟" أو "اكتب مساعدة"

العميل: ${context.name || 'غير معروف'}
السلة: ${context.hasItems ? `${context.itemCount} منتج (${context.totalValue} جنيه)` : 'فاضية'}
الحالة المزاجية: ${emotion}
النواية: ${intent}`;

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
        temperature: 0.7,
        max_tokens: 150,
        top_p: 0.9,
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

  // Detect user emotion with spelling tolerance
  detectEmotion(text) {
    const normalizedText = this.normalizeText(text);
    const emotions = {
      frustrated: ['مش شغال', 'بطل', 'خراب', 'زهق', 'عصب', 'غضبان', 'متضايق', 'مش فاهم', 'مش بيشتغل', 'وحش', 'سيئ'],
      excited: ['عظمة', 'حلو', 'ممتاز', 'جميل', 'رائع', 'لذيذ', 'حلوة', ' perfect', 'awesome', 'great'],
      confused: ['مش فاهم', 'ازاي', 'ازاى', 'ايه', 'مش عارف', 'صعب', 'معقد', 'مش فاهم', 'صعبه'],
      urgent: ['بسرعة', 'عاجل', 'دلوقتي', 'الحين', 'urgent', 'بسرعه', 'عالسريع', 'بسرعه'],
      happy: ['شكرا', 'تسلم', 'دومت', '❤️', '😍', '😊', '🥰', 'حبيت', 'عجبني'],
    };
    
    for (const [emotion, keywords] of Object.entries(emotions)) {
      if (keywords.some(k => this.fuzzyMatch(normalizedText, k, 0.8))) return emotion;
    }
    return 'neutral';
  }

  // Advanced intent detection with spelling tolerance
  detectAdvancedIntent(text) {
    const normalizedText = this.normalizeText(text);
    
    const intents = {
      complaint: ['مش كويس', 'سيئ', 'خراب', 'مش شغال', 'رديء', 'مش لذيذ', 'بارد', 'سخن', 'وحش', 'تأخير'],
      compliment: ['حلو', 'جميل', 'عظمة', 'ممتاز', 'رائع', 'لذيذ', 'طعمه حلو', ' perfect', 'good'],
      question_product: ['عندك', 'فيه', 'موجود', 'متاح', 'عندكم', 'ايش عندك'],
      question_price: ['بكام', 'سعر', 'cost', 'فلوس', 'قيمة', 'تكلفة', 'بكم'],
      question_time: ['امتى', 'متى', 'ساعة', 'وقت', 'دقيقة', 'امتا', 'توصيل'],
      small_talk: ['اخبارك', 'عمل ايه', 'كيفك', 'ازيك', 'صباح', 'مساء', 'نهارك', 'فطور', 'غدا'],
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
    
    // Emotional response adjustments
    const emotionalPrefix = {
      frustrated: `🤗 ${name}، أفهم إنك متضايق... خلني أساعدك:`,
      confused: `💡 ${name}، سهل جداً! خلني أوضحلك:`,
      urgent: `⚡ ${name}، هتصرف معاك فوراً:`,
      excited: `🎉 ${name}، شكلك متحمس!`,
      happy: `😊 ${name}، دايماً في خدمتك!`,
      neutral: ''
    };
    
    const prefix = emotionalPrefix[emotion] || '';
    
    // Context-aware greeting for returning customers
    const greeting = context.isReturningCustomer && context.messageCount > 5
      ? `${name}، نورتنا تاني! 🌟\n\n`
      : context.messageCount === 1
        ? `👋 أهلاً ${name} في ${shop.name}!\n\n`
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
        'السلام', 'ازيك', 'اخبارك', 'حياك', 'اهلين', 'هلا والله',
        // Common misspellings
        'مرحب', 'مرحب', 'اهلان', 'اهلين', 'هلاا', 'سلامم', 'مرحباً'
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
        'اخبارك', 'عمل ايه', 'كيفك', 'ازيك', 'صباح', 'مساء', 'نهارك', 
        'فطور', 'غدا', 'عشا', 'اكلك', 'اخبار', 'شو الاخبار',
        // Misspellings
        'اخبارر', 'اخباركك', 'كيففك', 'اززيك', 'صباحح'
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
        'ايوه', 'yes', 'أيوه', 'أيوة', 'ايوة', 'اوكي', 'تمام', 'ماشي', 'ok', 'okay',
        // Misspellings
        'ايووه', 'ايوهه', 'أيووه', 'اوكيي', 'تمامم'
      ],
      no: [
        'لا', 'no', 'لأ', 'لأ', 'مش', 'مش عايز', 'مش حابب',
        // Misspellings
        'لأأ', 'لاا', 'مشش'
      ],
      cancel: [
        'الغاء', 'cancel', 'stop', 'مش عايز', 'غير', 'ما ابغى', 'لا ابغى', 'مش عاوز',
        'الفاء', 'الغي', 'الغاء',
        // Misspellings
        'الغا', 'الغاءء', 'كانسل', 'cancle'
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
    return intentPatterns.some(p => this.fuzzyMatch(text, p, 0.75));
  }

  async getGreetingResponse(name, shop, context) {
    const hour = new Date().getHours();
    let timeGreeting = '';
    
    if (hour >= 5 && hour < 12) timeGreeting = 'صباح الفل ☀️';
    else if (hour >= 12 && hour < 17) timeGreeting = 'نهارك سعيد 🌤️';
    else if (hour >= 17 && hour < 21) timeGreeting = 'مساء الخير 🌆';
    else timeGreeting = 'تصبح على خير 🌙';
    
    if (context.hasItems) {
      return `${timeGreeting} ${name}! 😊\n\n` +
             `شايف إنك اخترت ${context.itemCount} منتجات (${context.totalValue} جنيه)\n` +
             `اكتب "كارت" لو عايز تشوف تفاصيل طلبك 🛒`;
    }
    
    return `${timeGreeting} ${name}! 🌟\n\n` +
           `أهلاً بيك في ${shop.name}! \n` +
           `عايز تشوف منتجاتنا؟ اكتب "قائمة" 📋`;
  }

  async getComplaintResponse(name, shop) {
    return `🙏 آسف جداً ${name} لو فيه أي مشكلة...\n\n` +
           `احنا هنا عشان نحلها على طول! \n` +
           `ممكن تتواصل مع صاحب المحل مباشرة على التليفون؟ 📞\n\n` +
           `أو اكتب "قائمة" لو عايز تشوف المنتجات المتاحة`;
  }

  async getComplimentResponse(name, shop) {
    const thanks = ['شكراً جزيلاً!', 'تسلم يا غالي!', 'ربنا يخليك!', 'دايماً في خدمتك!'];
    const randomThanks = thanks[Math.floor(Math.random() * thanks.length)];
    
    return `🥰 ${randomThanks} ${name}!\n\n` +
           `نورت ${shop.name}! \n` +
           `لو محتاج حاجة تانية، أنا تحت أمرك 😊`;
  }

  async getProductQuestionResponse(name, shop) {
    return `📦 ${name}، عندنا تشكيلة حلوة من المنتجات!\n\n` +
           `اكتب "قائمة" تشوف كل اللي موجود واختار اللي يناسبك 👌`;
  }

  async getPriceQuestionResponse(name, shop) {
    return `💰 ${name}، أسعارنا تنافسية وجودتنا ممتازة!\n\n` +
           `اكتب "قائمة" تشوف الأسعار مع كل منتج 📋`;
  }

  async getTimeQuestionResponse(name, shop) {
    return `⏰ ${name}، بنوصل الطلبات في أسرع وقت!\n\n` +
           `عادةً التوصيل بياخد من 30-60 دقيقة حسب الموقع\n` +
           `اكتب "اطلب" وابدأ طلبك دلوقتي! 🚀`;
  }

  async getSmallTalkResponse(name, shop, context) {
    const hour = new Date().getHours();
    let mealSuggestion = '';
    
    if (hour >= 7 && hour < 11) mealSuggestion = 'عندنا فطار لذيذ! 🥐';
    else if (hour >= 11 && hour < 16) mealSuggestion = 'جاهزين لغداء شهي! 🍽️';
    else if (hour >= 16 && hour < 22) mealSuggestion = 'عشاء لذيذ بيستنك! 🍲';
    
    return `😊 ${name}، الحمد لله تمام!\n\n` +
           (mealSuggestion ? `${mealSuggestion}\n` : '') +
           `اكتب "قائمة" لو عايز تشوف المنتجات المتاحة 🍽️`;
  }

  async getJokeResponse(name) {
    const jokes = [
      `😂 ${name}، ليه البيضة بتحب الجيم؟ عشان بتحب تتكسر الكرش!`,
      `🤣 ${name}، ليه السمكة مش بتستخدم الكمبيوتر؟ عشان خايفة من النت!`,
      `😅 ${name}، اتنين فطر بيتكلموا، واحد قال للتاني: أنت طعمك حلو، قاله: لا ده انت بتضحك!`,
    ];
    return jokes[Math.floor(Math.random() * jokes.length)] + '\n\nاكتب "قائمة" لو رجعنا للشغل 😂📋';
  }

  async getHelpResponse(name, shop, context) {
    let personalizedHelp = '';
    
    if (context.hasItems) {
      personalizedHelp = `💡 عندك ${context.itemCount} منتج في السلة!\n` +
                        `اكتب "كارت" تشوفهم أو "اطلب" لتأكيد\n\n`;
    }
    
    return `👋 ${name}، أنا هنا عشان أساعدك!\n\n` +
           personalizedHelp +
           `📋 "قائمة" - تشوف المنتجات\n` +
           `🛒 "كارت" - تشوف طلبك\n` +
           `✅ "اطلب" - تأكيد الطلب\n` +
           `💡 اكتب رقم المنتج مباشرة (1, 2, 3...)`;
  }

  async getSmartFallback(name, shop, context, greeting) {
    // Smart suggestions based on context
    let suggestion = '';
    
    if (context.hasItems) {
      suggestion = `💡 اكتب "كارت" تشوف طلبك (${context.totalValue} جنيه) أو "اطلب" لتأكيد ✅`;
    } else if (context.messageCount > 3) {
      suggestion = `💡 اكتب "قائمة" تشوف المنتجات المتاحة 📋`;
    } else {
      suggestion = `💡 ممكن تكتب "قائمة" أو "مساعدة" لو عايز تعرف الأوامر`;
    }
    
    const confusedResponses = [
      `🤔 ${name}، مش فاهم كويس...`,
      `😅 ${name}، ممكن توضح أكتر؟`,
      `💭 ${name}، عذراً مش قادر أفهم`,
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

  async sendHelpMessage(sock, from, shop, context = {}) {
    const name = context.name || 'يا فندم';
    let personalizedMsg = '';
    
    if (context.hasItems) {
      personalizedMsg = `🛒 عندك ${context.itemCount} منتج في السلة (${context.totalValue} جنيه)\n\n`;
    }
    
    const msg = `👋 ${name}، أنا مساعد ${shop.name}!\n\n` +
                personalizedMsg +
                `📱 الأوامر المتاحة:\n\n` +
                `📋 "قائمة" - عرض كل المنتجات\n` +
                `🛒 "كارت" - تشوف طلبك\n` +
                `✅ "اطلب" - تأكيد الطلب\n` +
                `👍 "ايوه" - أضف منتج تاني\n` +
                `👎 "لا" - كده تمام واطلب\n` +
                `❌ "الغاء" - فضي السلة\n\n` +
                `💡 أو اكتب رقم المنتج مباشرة (1, 2, 3...)`;
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
