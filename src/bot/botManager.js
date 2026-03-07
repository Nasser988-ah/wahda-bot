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

      // Add friendly greeting header to all responses
      const friendlyGreeting = `👋 أهلاً بيك في ${shop.name}!\n\n`;
      
      // Handle text commands first
      if (lowerText === 'قائمة' || lowerText === 'menu') {
        await this.sendProductsList(sock, from, shop, customerPhone, 1);
      } else if (lowerText === 'كارت' || lowerText === 'cart') {
        await this.showCart(sock, from, shop.id, customerPhone, shop);
      } else if (lowerText === 'اطلب' || lowerText === 'order') {
        await this.askForMoreItems(sock, from, shop.id, customerPhone, shop);
      } else if (lowerText === 'لا' || lowerText === 'no' || lowerText === 'تمام') {
        await this.confirmOrder(sock, from, shop.id, customerPhone, shop);
      } else if (lowerText === 'ايوه' || lowerText === 'yes' || lowerText === 'أيوه') {
        await this.safeSendMessage(sock, from, friendlyGreeting + `عظمة! اكتب رقم المنتج اللي عايزه أو اكتب "قائمة" لو عايز تشوف القائمة.`, shop.name);
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
        // Egyptian style fallback response
        await this.sendEgyptianResponse(sock, from, text, shop);
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
    try {
      console.log(`🛒 Processing order for ${customerPhone} at ${shop.name}`);
      
      const cartKey = `cart:${shopId}:${customerPhone}`;
      let cart;
      try {
        cart = await redis.get(cartKey);
        console.log(`🛒 Cart data for order:`, typeof cart, cart);
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
          console.log(`⚠️ JSON parse error in order: ${e.message}`);
          items = [];
        }
      }

      console.log(`🛒 Cart items: ${items.length}`);

      if (items.length === 0) {
        console.log(`❌ Cart is empty for ${customerPhone}`);
        await this.safeSendMessage(sock, from, "❌ السلة فارغة. أرسل قائمة لعرض المنتجات ثم أضف منتجات للسلة.", shop.name);
        return;
      }

      const total = items.reduce((sum, i) => sum + i.price * i.quantity, 0);
      console.log(`💰 Order total: ${total}`);

      const order = await prisma.order.create({
        data: {
          shopId,
          customerPhone,
          customerName: `عميل ${customerPhone}`,
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

      console.log(`✅ Order created: ${order.id.slice(-8)}`);

      let msg = `تم تأكيد طلبك رقم ${order.id.slice(-8)} ✅\n\n`;
      msg += `تفاصيل الطلب:\n`;
      items.forEach((i, idx) => {
        msg += `${idx + 1}. ${i.name}\n`;
        msg += `الكمية: ${i.quantity}\n`;
        msg += `السعر: ${i.price} جنيه\n`;
        msg += `الإجمالي: ${i.price * i.quantity} جنيه\n\n`;
      });
      msg += `المجموع الكلي: ${total} جنيه\n\n`;
      msg += `سيتم التواصل معك قريباً لتأكيد التوصيل.\n`;
      msg += `شكراً لاختيارك ${shop.name}!`;

      await this.safeSendMessage(sock, from, msg, shop.name);
      await redis.del(cartKey);

      console.log(`📤 Order confirmation sent to ${customerPhone}`);

      // Notify owner
      if (shop.whatsappNumber) {
        const ownerMsg = `طلب جديد من ${shop.name}\n\n` +
                        `رقم الطلب: ${order.id.slice(-8)}\n` +
                        `العميل: ${customerPhone}\n` +
                        `المبلغ: ${total} جنيه\n` +
                        `عدد المنتجات: ${items.length}\n\n` +
                        `يرجى التحقق من لوحة التحكم.`;
        
        await this.safeSendMessage(sock, `${shop.whatsappNumber}@s.whatsapp.net`, ownerMsg, shop.name);
        console.log(`📤 Owner notified at ${shop.whatsappNumber}`);
      }

    } catch (error) {
      console.error(`❌ Error in confirmOrder:`, error);
      await this.safeSendMessage(sock, from, "❌ حدث خطأ أثناء تأكيد الطلب. يرجى المحاولة مرة أخرى.", shop.name);
    }
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
        await this.safeSendMessage(sock, from, "السلة فاضية يا معلم! 😅\n\nاكتب \"قائمة\" الأول واختار منتج.", shop.name);
        return;
      }

      // Store the state that we're waiting for user's response
      await redis.set(`order_state:${shopId}:${customerPhone}`, 'waiting_for_more', { ex: 300 }); // 5 minutes
      
      const total = items.reduce((sum, i) => sum + i.price * i.quantity, 0);
      
      let message = `🛒 السلة بتاعتك:\n\n`;
      items.forEach((item, i) => {
        message += `${i + 1}. ${item.name}\n`;
        message += `   الكمية: ${item.quantity} × ${item.price} = ${item.price * item.quantity} جنيه\n\n`;
      });
      message += `💰 الإجمالي: ${total} جنيه\n\n`;
      message += `━━━━━━━━━━━━━━━━━━━━━\n\n`;
      message += `عايز تضيف حاجة تانية؟ 🤔\n\n`;
      message += `✨ إزاي أقدر أساعدك النهاردة؟\n\n`;
      message += `1️⃣ عرض المنتجات\n`;
      message += `2️⃣ سلة التسوق\n`;
      message += `3️⃣ اطلب دلوقتي\n`;
      message += `4️⃣ مساعدة\n\n`;
      message += `💡 اكتب رقم (1-4) أو سألني أي سؤال!`;
      
      await this.safeSendMessage(sock, from, message, shop.name);
      
    } catch (error) {
      console.error(`❌ Error in askForMoreItems:`, error);
      await this.safeSendMessage(sock, from, "حصل مشكلة صغيرة! جرب تاني.", shop.name);
    }
  }

  async sendNumberedMenu(sock, from, shop) {
    const menu = `👋 أهلاً بيك في ${shop.name}!\n\n` +
                 `✨ إزاي أقدر أساعدك النهاردة؟\n\n` +
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
    const greeting = `👋 أهلاً بيك في ${shop.name}!\n\n`;
    
    // Egyptian style responses for common questions
    if (lowerText.includes('مرحبا') || lowerText.includes('سلام') || lowerText.includes('اهلا') || lowerText.includes('هلا')) {
      await this.safeSendMessage(sock, from, greeting + `أهلاً بيك يا فندم! 😊\n\n1️⃣ عرض المنتجات\n2️⃣ سلة التسوق\n3️⃣ اطلب دلوقتي\n4️⃣ مساعدة\n\nاكتب رقم 1-4`, shop.name);
    } else if (lowerText.includes('مين') || lowerText.includes('who') || lowerText.includes('انت مين')) {
      await this.safeSendMessage(sock, from, greeting + `أنا بوت ${shop.name} يا معلم! 🤖\n\n1️⃣ عرض المنتجات\n2️⃣ سلة التسوق\n3️⃣ اطلب دلوقتي\n4️⃣ مساعدة\n\nاختار رقم وابدأ طلبك!`, shop.name);
    } else if (lowerText.includes('سعر') || lowerText.includes('بكم') || lowerText.includes('كام') || lowerText.includes('price')) {
      await this.safeSendMessage(sock, from, greeting + `الأسعار مختلفة يا فندم!\n\n1️⃣ اكتب "1" تشوف المنتجات\n2️⃣ كل منتج مع سعره واضح\n\nاختار 1 �`, shop.name);
    } else if (lowerText.includes('طلب') || lowerText.includes('order')) {
      await this.safeSendMessage(sock, from, greeting + `عشان تطلب سهل جداً:\n\n1️⃣ اكتب "1" تشوف المنتجات\n2️⃣ اختار رقم المنتج\n3️⃣ اكتب "3" تطلب\n\nجرب دلوقتي! 👍`, shop.name);
    } else if (lowerText.includes('منتج') || lowerText.includes('عندك') || lowerText.includes('products')) {
      await this.safeSendMessage(sock, from, greeting + `عندنا منتجات كتيرة!\n\n1️⃣ اكتب "1" تشوف القائمة\n2️⃣ اختار اللي نفسك فيه\n\nاكتب 1 👇`, shop.name);
    } else if (lowerText.includes('مساعدة') || lowerText.includes('help')) {
      await this.safeSendMessage(sock, from, greeting + `أقدر أساعدك! 🤔\n\n1️⃣ منتجات\n2️⃣ سلة التسوق\n3️⃣ اطلب\n4️⃣ مساعدة\n\nاكتب رقم 1-4`, shop.name);
    } else if (lowerText.includes('شكرا') || lowerText.includes('thank')) {
      await this.safeSendMessage(sock, from, greeting + `العفو يا فندم! 😊\n\n1️⃣ عرض المنتجات\n2️⃣ سلة التسوق\n3️⃣ اطلب دلوقتي\n4️⃣ مساعدة\n\nفي خدمتك!`, shop.name);
    } else {
      // Default numbered menu
      await this.sendNumberedMenu(sock, from, shop);
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
