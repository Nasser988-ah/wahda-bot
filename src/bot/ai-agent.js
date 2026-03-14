/**
 * AI-Agent WhatsApp Bot
 * Standalone customer service bot with DeepSeek AI
 * No database required - works with simple menu and order collection
 */

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const path = require("path");
const fs = require("fs");
const qrcode = require("qrcode");

// DeepSeek API (cheaper alternative to Groq)
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1';

// Redis for session storage
let redis;
try {
  redis = require("../db/redis");
} catch (e) {
  // Fallback: simple in-memory storage
  const memoryStore = new Map();
  redis = {
    get: async (key) => memoryStore.get(key) || null,
    set: async (key, value, opts) => { memoryStore.set(key, value); },
    del: async (key) => memoryStore.delete(key),
  };
  console.log('⚠️ Using in-memory storage (Redis not available)');
}

// ============================================
// SHOP CONFIGURATION
// ============================================
const SHOP_CONFIG = {
  name: process.env.SHOP_NAME || 'متجرنا',
  phone: process.env.SHOP_PHONE || '', // Owner's WhatsApp for notifications
  currency: 'جنيه',
  // Pre-made menu - edit this array to add your products
  menu: [
    { id: 1, name: 'برجر لحم', price: 85, description: 'برجر لحم بقري 200جرام مع الجبنة والخضار' },
    { id: 2, name: 'برجر دجاج', price: 75, description: 'صدر دجاج مشوي مع الخس والطماطم' },
    { id: 3, name: 'بيتزا مارجريتا', price: 95, description: 'صلصة طماطم، موزاريلا، ريحان' },
    { id: 4, name: 'بيتزا بيبروني', price: 110, description: 'بيبروني، موزاريلا، صلصة خاصة' },
    { id: 5, name: 'عصير برتقال طازج', price: 35, description: 'عصير برتقال طبيعي 100%' },
    { id: 6, name: 'عصير مانجو', price: 40, description: 'مانجو طازج مع حليب' },
    { id: 7, name: 'بطاطس مقلية', price: 30, description: 'بطاطس مقرمشة مع صلصة' },
    { id: 8, name: 'سلطة خضراء', price: 45, description: 'خس، خيار، طماطم، زيتون' },
  ]
};

// ============================================
// DEEPSEEK AI INTEGRATION
// ============================================
async function getDeepSeekResponse(messages, temperature = 0.7) {
  if (!DEEPSEEK_API_KEY) {
    console.log('⚠️ DEEPSEEK_API_KEY not set, using fallback responses');
    return null;
  }

  try {
    const response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: messages,
        temperature: temperature,
        max_tokens: 500
      })
    });

    if (!response.ok) {
      throw new Error(`DeepSeek API error: ${response.status}`);
    }

    const data = await response.json();
    return data.choices[0]?.message?.content?.trim();
  } catch (error) {
    console.error('❌ DeepSeek API error:', error.message);
    return null;
  }
}

// ============================================
// HELPER FUNCTIONS
// ============================================

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

function findProductByName(text) {
  const normalizedInput = normalizeArabic(text);
  
  for (const product of SHOP_CONFIG.menu) {
    const normalizedName = normalizeArabic(product.name);
    
    // Exact match
    if (normalizedInput === normalizedName) return product;
    
    // Contains
    if (normalizedName.includes(normalizedInput) || 
        normalizedInput.includes(normalizedName)) return product;
    
    // Word matching
    const inputWords = normalizedInput.split(' ').filter(w => w.length > 2);
    const nameWords = normalizedName.split(' ').filter(w => w.length > 2);
    
    for (const iw of inputWords) {
      for (const nw of nameWords) {
        if (nw.includes(iw) || iw.includes(nw)) return product;
      }
    }
  }
  
  return null;
}

function formatMenu() {
  let msg = `📋 *قائمة ${SHOP_CONFIG.name}*\n\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n\n`;
  
  SHOP_CONFIG.menu.forEach(p => {
    msg += `${p.id}. *${p.name}*\n`;
    msg += `   💰 ${p.price} ${SHOP_CONFIG.currency}\n`;
    msg += `   📝 ${p.description}\n\n`;
  });
  
  msg += `━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `💡 *للطلب:* اكتب رقم المنتج أو اسمه\n`;
  msg += `🛒 اكتب *كارت* لعرض سلتك\n`;
  msg += `✅ اكتب *اطلب* لتأكيد الطلب`;
  
  return msg;
}

function formatWelcome() {
  return `أهلاً وسهلاً! مرحباً بك في *${SHOP_CONFIG.name}* 👋\n\n` +
    `*أنا ذكي، موظف خدمة العملاء* 🤖\n` +
    `أفهم أوامرك وأساعدك في الطلب بسرعة وسهولة.\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `*كيفية الاستخدام:*\n\n` +
    `📋 اكتب *قائمة* لعرض المنتجات\n` +
    `🔢 اكتب *رقم المنتج* (مثال: 1 أو 2)\n` +
    `📝 اكتب *اسم المنتج* مباشرة (مثال: برجر)\n` +
    `🛒 اكتب *كارت* لعرض السلة\n` +
    `✅ اكتب *اطلب* لتأكيد الطلب\n` +
    `❌ اكتب *إلغاء* لمسح السلة\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `ابدأ الآن باكتب *قائمة* 👇`;
}

// ============================================
// AI AGENT CLASS
// ============================================
class AIAgent {
  constructor() {
    this.sock = null;
    this.qrCode = null;
    this.isConnected = false;
    this.sessionDir = path.resolve('./ai-agent-session');
  }

  async start() {
    console.log(`🚀 Starting AI Agent for ${SHOP_CONFIG.name}...`);
    
    // Ensure session directory exists
    if (!fs.existsSync(this.sessionDir)) {
      fs.mkdirSync(this.sessionDir, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(this.sessionDir);

    this.sock = makeWASocket({
      auth: state,
      logger: pino({ level: "silent" }),
      printQRInTerminal: false,
      keepAliveIntervalMs: 30000,
      connectTimeoutMs: 60000,
      qrTimeout: 60000,
      defaultQueryTimeoutMs: 20000,
      retryRequestDelayMs: 500,
      maxMsgRetryCount: 3,
    });

    // Handle connection events
    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      if (qr) {
        console.log('📱 New QR code received');
        this.qrCode = qr;
        this.isConnected = false;
        
        // Generate QR image for owner
        try {
          const qrPath = path.join(this.sessionDir, 'qr-code.png');
          await qrcode.toFile(qrPath, qr, { 
            type: 'png',
            width: 400,
            margin: 2
          });
          console.log(`✅ QR code saved to: ${qrPath}`);
        } catch (e) {
          console.error('❌ Failed to save QR:', e.message);
        }
      }
      
      if (connection === 'open') {
        console.log('✅ AI Agent connected to WhatsApp!');
        this.isConnected = true;
        this.qrCode = null;
      }
      
      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.log(`⚠️ Connection closed: ${statusCode}`);
        this.isConnected = false;
        
        if (statusCode !== DisconnectReason.loggedOut) {
          console.log('🔄 Reconnecting in 5 seconds...');
          setTimeout(() => this.start(), 5000);
        }
      }
    });

    // Save credentials
    this.sock.ev.on('creds.update', saveCreds);

    // Handle messages
    this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      const msg = messages[0];
      if (!msg?.message || msg.key.fromMe) return;
      
      await this.handleMessage(msg);
    });
  }

  async handleMessage(msg) {
    try {
      const from = msg.key.remoteJid;
      const customerPhone = from.split('@')[0];
      
      const rawText = msg.message?.conversation || 
                       msg.message?.extendedTextMessage?.text || '';
      const text = rawText.trim();
      
      if (!text) return;
      
      console.log(`📩 Message from ${customerPhone}: "${text}"`);
      
      const lowerText = text.toLowerCase();
      
      // Check for pending states first
      const stateKey = `state:${customerPhone}`;
      const state = await redis.get(stateKey);
      
      if (state) {
        const handled = await this.handleState(from, customerPhone, text, state);
        if (handled) return;
      }
      
      // Handle commands
      if (this.isMenuCommand(lowerText)) {
        await this.sendMenu(from);
        return;
      }
      
      if (this.isCartCommand(lowerText)) {
        await this.showCart(from, customerPhone);
        return;
      }
      
      if (this.isOrderCommand(lowerText)) {
        await this.startOrder(from, customerPhone);
        return;
      }
      
      if (this.isCancelCommand(lowerText)) {
        await this.cancelCart(from, customerPhone);
        return;
      }
      
      // Check for product number
      if (/^\d+$/.test(text)) {
        const productNum = parseInt(text);
        const product = SHOP_CONFIG.menu.find(p => p.id === productNum);
        if (product) {
          await this.addToCart(from, customerPhone, product);
          return;
        }
      }
      
      // Check for product name
      const matchedProduct = findProductByName(text);
      if (matchedProduct) {
        await this.addToCart(from, customerPhone, matchedProduct);
        return;
      }
      
      // Use AI for unknown messages
      await this.handleWithAI(from, customerPhone, text);
      
    } catch (error) {
      console.error('❌ Error handling message:', error.message);
    }
  }

  isMenuCommand(text) {
    return ['قائمة', 'منيو', 'menu', 'القائمة', 'products'].includes(text);
  }

  isCartCommand(text) {
    return ['كارت', 'سلة', 'cart', 'طلبي', 'السلة'].includes(text);
  }

  isOrderCommand(text) {
    return ['اطلب', 'order', 'أطلب', 'تأكيد', 'confirm'].includes(text);
  }

  isCancelCommand(text) {
    return ['إلغاء', 'الغاء', 'cancel', 'امسح', 'clear'].includes(text);
  }

  async sendMenu(to) {
    await this.sock.sendMessage(to, { text: formatMenu() });
  }

  async showCart(to, customerPhone) {
    const cartKey = `cart:${customerPhone}`;
    const cartData = await redis.get(cartKey);
    
    if (!cartData || JSON.parse(cartData).length === 0) {
      await this.sock.sendMessage(to, { 
        text: `🛒 سلة التسوق فارغة\n\nاكتب *قائمة* لعرض المنتجات المتاحة.` 
      });
      return;
    }
    
    const cart = JSON.parse(cartData);
    let msg = `🛒 *سلة التسوق*\n\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━\n\n`;
    
    let total = 0;
    cart.forEach((item, i) => {
      const subtotal = item.price * item.quantity;
      total += subtotal;
      msg += `${i + 1}. ${item.name}\n`;
      msg += `   الكمية: ${item.quantity}\n`;
      msg += `   السعر: ${subtotal} ${SHOP_CONFIG.currency}\n\n`;
    });
    
    msg += `━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `💰 *الإجمالي: ${total} ${SHOP_CONFIG.currency}*\n\n`;
    msg += `✅ اكتب *اطلب* لتأكيد الطلب\n`;
    msg += `❌ اكتب *إلغاء* لمسح السلة`;
    
    await this.sock.sendMessage(to, { text: msg });
  }

  async addToCart(to, customerPhone, product) {
    const cartKey = `cart:${customerPhone}`;
    let cart = [];
    
    const existing = await redis.get(cartKey);
    if (existing) {
      cart = JSON.parse(existing);
    }
    
    const existingItem = cart.find(i => i.id === product.id);
    if (existingItem) {
      existingItem.quantity += 1;
    } else {
      cart.push({ ...product, quantity: 1 });
    }
    
    await redis.set(cartKey, JSON.stringify(cart), { ex: 3600 });
    
    const total = cart.reduce((s, i) => s + (i.price * i.quantity), 0);
    
    await this.sock.sendMessage(to, {
      text: `✅ تمت إضافة *${product.name}* إلى السلة\n\n` +
            `💰 إجمالي السلة: ${total} ${SHOP_CONFIG.currency}\n\n` +
            `🛒 اكتب *كارت* لعرض السلة\n` +
            `📋 اكتب *قائمة* لإضافة المزيد`
    });
  }

  async cancelCart(to, customerPhone) {
    const cartKey = `cart:${customerPhone}`;
    await redis.del(cartKey);
    await redis.del(`state:${customerPhone}`);
    await redis.del(`order_name:${customerPhone}`);
    await redis.del(`order_phone:${customerPhone}`);
    await redis.del(`order_address:${customerPhone}`);
    
    await this.sock.sendMessage(to, {
      text: `✅ تم مسح السلة بنجاح\n\n` +
            `📋 اكتب *قائمة* لعرض المنتجات`
    });
  }

  async startOrder(to, customerPhone) {
    const cartKey = `cart:${customerPhone}`;
    const cartData = await redis.get(cartKey);
    
    if (!cartData || JSON.parse(cartData).length === 0) {
      await this.sock.sendMessage(to, {
        text: `⚠️ السلة فارغة!\n\n` +
              `📋 اكتب *قائمة* لاختيار منتجات أولاً`
      });
      return;
    }
    
    // Start collecting customer details
    const stateKey = `state:${customerPhone}`;
    await redis.set(stateKey, 'waiting_name', { ex: 600 });
    
    await this.sock.sendMessage(to, {
      text: `📝 *لإتمام طلبك، أحتاج بعض المعلومات:*\n\n` +
            `الخطوة 1 من 3\n` +
            `👤 *ما اسمك؟*`
    });
  }

  async handleState(to, customerPhone, text, state) {
    const stateKey = `state:${customerPhone}`;
    
    if (state === 'waiting_name') {
      await redis.set(`order_name:${customerPhone}`, text.trim(), { ex: 600 });
      await redis.set(stateKey, 'waiting_phone', { ex: 600 });
      
      await this.sock.sendMessage(to, {
        text: `✅ شكراً ${text.trim()}!\n\n` +
              `الخطوة 2 من 3\n` +
              `📱 *رقم هاتفك؟* (مثال: 01012345678)`
      });
      return true;
    }
    
    if (state === 'waiting_phone') {
      const phone = text.replace(/\s/g, '');
      if (!/^0?1\d{9}$/.test(phone)) {
        await this.sock.sendMessage(to, {
          text: `⚠️ رقم الهاتف غير صحيح\n\n` +
                `يرجى إدخال رقم صحيح مثل: 01012345678`
        });
        return true;
      }
      
      await redis.set(`order_phone:${customerPhone}`, phone, { ex: 600 });
      await redis.set(stateKey, 'waiting_address', { ex: 600 });
      
      await this.sock.sendMessage(to, {
        text: `✅ تمام!\n\n` +
              `الخطوة 3 من 3\n` +
              `📍 *عنوان التوصيل؟* (المنطقة، الشارع، رقم المبنى)`
      });
      return true;
    }
    
    if (state === 'waiting_address') {
      await redis.set(`order_address:${customerPhone}`, text.trim(), { ex: 600 });
      await redis.del(stateKey);
      
      // Complete order
      await this.completeOrder(to, customerPhone);
      return true;
    }
    
    return false;
  }

  async completeOrder(to, customerPhone) {
    const cartKey = `cart:${customerPhone}`;
    const cartData = await redis.get(cartKey);
    
    if (!cartData) return;
    
    const cart = JSON.parse(cartData);
    const name = await redis.get(`order_name:${customerPhone}`);
    const phone = await redis.get(`order_phone:${customerPhone}`);
    const address = await redis.get(`order_address:${customerPhone}`);
    
    const total = cart.reduce((s, i) => s + (i.price * i.quantity), 0);
    
    // Send confirmation to customer
    let msg = `🎉 *تم استلام طلبك بنجاح!*\n\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `👤 *الاسم:* ${name}\n`;
    msg += `📱 *الهاتف:* ${phone}\n`;
    msg += `📍 *العنوان:* ${address}\n\n`;
    msg += `🛒 *تفاصيل الطلب:*\n`;
    
    cart.forEach((item, i) => {
      msg += `${i + 1}. ${item.name} × ${item.quantity} = ${item.price * item.quantity} ${SHOP_CONFIG.currency}\n`;
    });
    
    msg += `\n💰 *الإجمالي: ${total} ${SHOP_CONFIG.currency}*\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━\n\n`;
    msg += `⏰ سنتواصل معك قريباً لتأكيد الطلب\n`;
    msg += `شكراً لاختيارك ${SHOP_CONFIG.name}! 🙏`;
    
    await this.sock.sendMessage(to, { text: msg });
    
    // Notify owner
    await this.notifyOwner(customerPhone, name, phone, address, cart, total);
    
    // Clear cart and order data
    await redis.del(cartKey);
    await redis.del(`order_name:${customerPhone}`);
    await redis.del(`order_phone:${customerPhone}`);
    await redis.del(`order_address:${customerPhone}`);
    
    // Save order to file (simple persistence)
    this.saveOrder({
      customerPhone,
      name,
      phone,
      address,
      items: cart,
      total,
      timestamp: new Date().toISOString(),
      status: 'NEW'
    });
  }

  async notifyOwner(customerPhone, name, phone, address, cart, total) {
    if (!SHOP_CONFIG.phone) {
      console.log('⚠️ SHOP_PHONE not set, cannot notify owner');
      return;
    }
    
    const ownerJid = `${SHOP_CONFIG.phone}@s.whatsapp.net`;
    
    let msg = `🔔 *طلب جديد!*\n\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `👤 *العميل:* ${name}\n`;
    msg += `📱 *الهاتف:* ${phone}\n`;
    msg += `📍 *العنوان:* ${address}\n`;
    msg += `💬 *واتساب:* ${customerPhone}\n\n`;
    msg += `🛒 *الطلب:*\n`;
    
    cart.forEach((item, i) => {
      msg += `   ${i + 1}. ${item.name} × ${item.quantity}\n`;
    });
    
    msg += `\n💰 *الإجمالي: ${total} ${SHOP_CONFIG.currency}*\n`;
    msg += `⏰ *الوقت:* ${new Date().toLocaleString('ar-EG')}\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━`;
    
    try {
      await this.sock.sendMessage(ownerJid, { text: msg });
      console.log(`✅ Order notification sent to owner`);
    } catch (error) {
      console.error('❌ Failed to notify owner:', error.message);
    }
  }

  saveOrder(order) {
    try {
      const ordersFile = path.join(this.sessionDir, 'orders.json');
      let orders = [];
      
      if (fs.existsSync(ordersFile)) {
        orders = JSON.parse(fs.readFileSync(ordersFile, 'utf8'));
      }
      
      orders.push(order);
      fs.writeFileSync(ordersFile, JSON.stringify(orders, null, 2));
      console.log(`✅ Order saved to ${ordersFile}`);
    } catch (error) {
      console.error('❌ Failed to save order:', error.message);
    }
  }

  async handleWithAI(to, customerPhone, text) {
    // Build conversation context
    const historyKey = `history:${customerPhone}`;
    let history = [];
    
    const existing = await redis.get(historyKey);
    if (existing) {
      history = JSON.parse(existing);
    }
    
    // Add user message
    history.push({ role: 'user', content: text });
    
    // Keep only last 5 messages
    if (history.length > 5) {
      history = history.slice(-5);
    }
    
    // Build system prompt
    const menuList = SHOP_CONFIG.menu.map(p => `${p.id}. ${p.name} (${p.price} ${SHOP_CONFIG.currency})`).join('\n');
    
    const systemPrompt = `أنت موظف خدمة عملاء اسمك *ذكي* تعمل في ${SHOP_CONFIG.name}.

هويتك:
- اسمك: ذكي
- وظيفتك: موظف خدمة عملاء محترف
- لا تقل أبداً أنك بوت أو ذكاء اصطناعي

القائمة المتاحة:
${menuList}

قواعد هامة:
1. استخدم اللغة العربية الفصحى فقط (لا عامية)
2. ردودك قصيرة (2-3 جمل كحد أقصى)
3. إذا سأل عن منتج، اذكر سعره من القائمة
4. إذا أراد الطلب، اشرح أنه يكتب رقم المنتج ثم "اطلب"
5. إذا طلب شيء غير موجود، اعتذر بلطف
6. كُن محترفاً ومهذباً دائماً

ممنوع: أيوه، تمام، ماشي، كويس، ازيك، عايز، مش، إيه، فين
مسموح: نعم، حسناً، تريد، أين، كيف، عفواً`;

    const messages = [
      { role: 'system', content: systemPrompt },
      ...history
    ];
    
    // Get AI response
    const aiResponse = await getDeepSeekResponse(messages, 0.7);
    
    if (aiResponse) {
      await this.sock.sendMessage(to, { text: aiResponse });
      
      // Add AI response to history
      history.push({ role: 'assistant', content: aiResponse });
      await redis.set(historyKey, JSON.stringify(history), { ex: 3600 });
    } else {
      // Fallback response
      await this.sock.sendMessage(to, {
        text: `عذراً، لم أفهم طلبك.\n\n` +
              `📋 اكتب *قائمة* لعرض المنتجات\n` +
              `💡 أو اكتب رقم المنتج مباشرة`
      });
    }
  }

  getQRCode() {
    return this.qrCode;
  }

  getStatus() {
    return {
      connected: this.isConnected,
      hasQR: !!this.qrCode,
      shopName: SHOP_CONFIG.name
    };
  }
}

// ============================================
// START THE AGENT
// ============================================
const agent = new AIAgent();
agent.start().catch(console.error);

// Export for potential external use
module.exports = { AIAgent, agent, SHOP_CONFIG };
