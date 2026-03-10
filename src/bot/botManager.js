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

const prisma = databaseService.getClient();

class BotManager {
  constructor() {
    this.connections = new Map();
    this.qrCallbacks = new Map();
    this.connectionStates = new Map();
    this.qrReceived = new Map();
    this.currentQrs = new Map(); // Store current QR codes
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
      
      // NEVER clear existing session - only create if doesn't exist
      // Session should only be deleted on explicit logout
      if (!fs.existsSync(sessionDir)) {
        console.log(`📁 Creating new session directory for ${shop.name}`);
        fs.mkdirSync(sessionDir, { recursive: true });
      } else {
        console.log(`📁 Using existing session for ${shop.name}`);
      }
      
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

      // Handle credentials update with logging
      sock.ev.on('creds.update', () => {
        saveCreds();
        console.log(`💾 Session credentials saved for ${shop.name} (${shopId})`);
      });

      // Handle connection updates
      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // Handle QR code
        if (qr && qrCallback && !this.qrReceived.get(shopId)) {
          console.log(`📱 QR received for ${shop.name}`);
          this.qrReceived.set(shopId, true);
          this.setCurrentQr(shopId, qr); // Store QR for later retrieval
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
      
      // Extract and normalize text (convert Arabic numbers to English)
      const rawText = msg.message?.conversation || 
                   msg.message?.extendedTextMessage?.text || 
                   msg.message?.imageMessage?.caption || 
                   msg.message?.videoMessage?.caption || '';
      
      const text = normalizeNumbers(rawText);

      if (!text.trim()) return;

      console.log(`📩 ${shop.name} - Message from ${customerPhone}: "${text}"`);

      const lowerText = text.toLowerCase().trim();

      // Get conversation context for smarter responses
      const context = await this.getConversationContext(shop.id, customerPhone);
      
      // Update message history for context awareness
      await this.updateMessageHistory(shop.id, customerPhone, text, 'user');

      // Check for order states first - handle name/phone/address collection
      // FIX: Smart state handling - allow cancel and questions during info collection
      const orderState = await redis.get(`order_state:${shop.id}:${customerPhone}`);
      
      if (orderState === 'waiting_for_name' || orderState === 'waiting_for_phone' || orderState === 'waiting_for_address') {
        // Check if customer wants to cancel during info collection
        const cancelWords = /الغاء|إلغاء|الغي|إلغي|امسح|cancel|لا|مش عايز|بطل|اوقف|لأ|لا اريد|مش عايز اكمل|الغي الطلب/;
        if (cancelWords.test(lowerText)) {
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
      // FIX 3: Check for frustration and repeating messages
      console.log(`🔍 Processing message: "${lowerText}"`);
      
      // Track message count for AI takeover decision
      const msgCountKey = `msgcount:${shop.id}:${customerPhone}`;
      const msgCount = parseInt(await redis.get(msgCountKey) || '0') + 1;
      await redis.set(msgCountKey, msgCount, { ex: 3600 });
      
      // Check if customer is frustrated
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
      
      if (this.matchesIntent(lowerText, 'menu')) {
        console.log(`✓ Matched: menu`);
        await this.sendProductsList(sock, from, shop, customerPhone, 1);
      } else if (this.matchesIntent(lowerText, 'cart')) {
        console.log(`✓ Matched: cart`);
        await this.showCart(sock, from, shop.id, customerPhone, shop);
      } else if (this.matchesIntent(lowerText, 'order')) {
        console.log(`✓ Matched: order`);
        await this.askForMoreItems(sock, from, shop.id, customerPhone, shop);
      } else if (this.matchesIntent(lowerText, 'no')) {
        console.log(`✓ Matched: no`);
        await this.handleNoResponse(sock, from, shop, customerPhone);
      } else if (this.matchesIntent(lowerText, 'yes')) {
        console.log(`✓ Matched: yes`);
        await this.handleYesResponse(sock, from, shop, customerPhone, context);
      } else if (lowerText.startsWith('عنوان:') || lowerText.startsWith('العنوان:') || lowerText.startsWith('address:')) {
        console.log(`✓ Matched: address input`);
        await this.handleAddressInput(sock, from, shop.id, customerPhone, shop, text);
      } else if (/^0?1\d{9}$/.test(text.replace(/\s/g, ''))) {
        console.log(`✓ Matched: phone number`);
        await this.handlePhoneInput(sock, from, shop.id, customerPhone, shop, text.replace(/\s/g, ''));
      } else if (lowerText.startsWith('صفحة ') || lowerText.startsWith('page ')) {
        console.log(`✓ Matched: page navigation`);
        const pageNum = parseInt(text.split(' ')[1]) || 1;
        await this.sendProductsList(sock, from, shop, customerPhone, pageNum);
      } else if (this.matchesIntent(lowerText, 'cancel')) {
        console.log(`✓ Matched: cancel`);
        await this.handleCancelCommand(sock, from, shop, customerPhone);
      } else if (this.matchesIntent(lowerText, 'help')) {
        console.log(`✓ Matched: help`);
        await this.sendHelpMessage(sock, from, shop, context);
      } else if (/^\d+$/.test(text)) {
        console.log(`✓ Matched: product number`);
        await this.addToCart(sock, from, shop.id, customerPhone, parseInt(text), shop);
      } else {
        // FIX 3: Always use AI for unknown messages
        console.log(`→ No command match, using AI response`);
        await this.handleWithAI(sock, from, text, shop, customerPhone);
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

  async sendProductsList(sock, from, shop, customerPhone, page = 1) {
    const availableProducts = shop.products.filter(p => p.isAvailable);
    
    if (availableProducts.length === 0) {
      await this.safeSendMessage(sock, from, "لا توجد منتجات متاحة حالياً.\n\nيرجى التواصل معنا مباشرة على الهاتف.", shop.name);
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
    message += `💡 للطلب:\n`;
    message += `اكتب رقم المنتج (مثلاً: ${startIndex + 1})\n\n`;
    
    if (totalPages > 1) {
      if (page < totalPages) {
        message += `📄 اكتب "صفحة ${page + 1}" للصفحة التالية\n`;
      }
      if (page > 1) {
        message += `📄 اكتب "صفحة ${page - 1}" للصفحة السابقة\n`;
      }
    }
    
    await this.safeSendMessage(sock, from, message, shop.name);
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
        `تمت إضافة ${product.name} إلى السلة ✅\n\n` +
        `لديك الآن ${totalItems} منتج في السلة\n\n` +
        `اكتب *كارت* لعرض طلبك\n` +
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
        message += `${i + 1}. ${item.name}\n`;
        message += `الكمية: ${item.quantity}\n`;
        message += `السعر: ${subtotal} جنيه\n`;
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

  // Smart cancel with empathy - ENHANCED
  async handleCancelCommand(sock, from, shop, customerPhone) {
    const cartKey = `cart:${shop.id}:${customerPhone}`;
    await redis.del(cartKey);
    // FIX 5: Friendly cancel message
    await this.safeSendMessage(sock, from, 
      "تم مسح سلتك بنجاح ✅\nنتمنى أن نراك مجدداً! اكتب *قائمة* لتصفح منتجاتنا.", shop.name, shop.id, customerPhone);
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

  // Smart response handler with emotional intelligence and Groq AI
  async handleSmartResponse(sock, from, shop, customerPhone, text, context) {
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
      const systemPrompt = `أنت مساعد متجر ${shop.name}.

قواعد صارمة جداً:
1. استخدم اللغة العربية الفصحى فقط في جميع ردودك
2. ممنوع منعاً باتاً استخدام: أيوه، لأ، تمام، ماشي، كويس، عامل، ازيك، يلا، بص، معلش، خلاص، زي، أوي، هنا دي، كسر الكرش، تخاف من الشبكة
3. إذا سألك العميل عن حالك أو حياك ("عامل إيه" أو "ازيك")، رد بـ: "أهلاً بك! كيف يمكنني مساعدتك اليوم؟"
4. ردودك قصيرة لا تتجاوز 3 جمل
5. لا تخترع منتجات غير موجودة في القائمة
6. كن ودوداً ومحترفاً

المنتجات المتاحة: ${shop.products?.filter(p => p.isAvailable).map(p => p.name).join(', ') || 'منتجات متنوعة'}

${contextMessage}
آخر ما فعله العميل: ${lastResponse || 'بدأ المحادثة'}

العميل: ${context.name || 'غير معروف'}
السلة: ${context.hasItems ? `${context.itemCount} منتج (${context.totalValue} جنيه)` : 'فارغة'}
الحالة: ${intent}`;

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
              price: i.price
            }))
          }
        }
      });

      // FIX 5: Friendly order confirmed message
      let msg = `تم استلام طلبك بنجاح! 🎉\n\n`;
      msg += `📱 رقم التليفون: ${customerPhoneNumber}\n`;
      msg += `📍 عنوان التوصيل: ${customerAddress}\n\n`;
      msg += `🛒 تفاصيل الطلب:\n`;
      items.forEach((i, idx) => {
        msg += `${idx + 1}. ${i.name} × ${i.quantity} = ${i.price * i.quantity} جنيه\n`;
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
            `   ${idx + 1}. ${i.name}\n` +
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
      
      const systemPrompt = `أنت مساعد ودود ومحترف لمتجر "${shop.name}".

منتجاتنا المتاحة:
${productsList}

حالة سلة العميل: ${cartSummary}

تعليمات مهمة جداً:
1. استخدم اللغة العربية الفصحى فقط
2. كن لطيفاً وودوداً دائماً
3. ردودك قصيرة (جملتين أو ثلاث فقط)
4. إذا أراد العميل إلغاء شيء قله يكتب "إلغاء"
5. إذا أراد رؤية القائمة قله يكتب "قائمة"
6. إذا أراد تأكيد الطلب قله يكتب "اطلب"
7. لا تكرر نفس الرد مرتين
8. إذا بدا العميل محبطاً اعتذر بلطف وساعده`;
      
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

module.exports = BotManager;
