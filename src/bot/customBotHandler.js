const databaseService = require("../services/databaseService");
const redis = require("../db/redis");
const geminiService = require("../services/geminiService");

function getPrisma() {
  return databaseService.getClient();
}

// Normalize Arabic numerals to English
function normalizeNumbers(text) {
  if (!text) return '';
  const map = { '٠':'0','١':'1','٢':'2','٣':'3','٤':'4','٥':'5','٦':'6','٧':'7','٨':'8','٩':'9' };
  return text.replace(/[٠-٩]/g, d => map[d] || d);
}

// Normalize Arabic text for fuzzy matching
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

// Simple similarity score
function similarity(a, b) {
  const na = normalizeArabic(a);
  const nb = normalizeArabic(b);
  if (na === nb) return 1;
  if (nb.includes(na) || na.includes(nb)) return 0.85;
  // Character overlap
  const setA = new Set(na.split(''));
  const setB = new Set(nb.split(''));
  let common = 0;
  setA.forEach(c => { if (setB.has(c)) common++; });
  return common / Math.max(setA.size, setB.size);
}

// Redis keys
const keys = {
  state: (shopId, phone) => `custom:state:${shopId}:${phone}`,
  menuStack: (shopId, phone) => `custom:menustack:${shopId}:${phone}`,
  orderData: (shopId, phone) => `custom:order:${shopId}:${phone}`,
  history: (shopId, phone) => `custom:history:${shopId}:${phone}`,
  lastActive: (shopId, phone) => `custom:active:${shopId}:${phone}`,
};

const TTL = 3600; // 1 hour session

// Safe send message with rate limiting
const lastSent = new Map();
async function safeSend(sock, to, text) {
  const key = `${to}:${text.slice(0, 50)}`;
  const now = Date.now();
  if (lastSent.has(key) && now - lastSent.get(key) < 3000) return;
  lastSent.set(key, now);
  try {
    await sock.sendMessage(to, { text });
  } catch (err) {
    console.error('❌ Custom bot send error:', err.message);
  }
}

// Load bot config and menus for a shop
async function loadBotData(shopId) {
  const prisma = getPrisma();
  const [config, menus] = await Promise.all([
    prisma.botConfig.findUnique({ where: { shopId } }),
    prisma.customMenu.findMany({
      where: { shopId, isActive: true },
      include: { items: { orderBy: { number: 'asc' } } },
      orderBy: { order: 'asc' },
    }),
  ]);
  return { config, menus };
}

// Format a menu for display
function formatMenu(menu, welcomePrefix = '') {
  if (!menu || !menu.items || menu.items.length === 0) return null;
  let text = welcomePrefix ? welcomePrefix + '\n\n' : '';
  text += `📋 *${menu.name}*\n`;
  if (menu.description) text += `${menu.description}\n`;
  text += '\n';
  menu.items.forEach(item => {
    const price = item.price ? ` - ${item.price} ج.م` : '';
    const desc = item.description ? `\n   ${item.description}` : '';
    text += `*${item.number}.* ${item.label}${price}${desc}\n`;
  });
  text += '\n💡 أرسل رقم الخيار';
  return text;
}

// Get or init customer state
async function getState(shopId, phone) {
  const raw = await redis.get(keys.state(shopId, phone));
  if (raw && typeof raw === 'string') {
    return JSON.parse(raw);
  } else if (raw && typeof raw === 'object') {
    return raw;
  }
  return { currentMenuId: null, step: 'idle', data: {} };
}

async function setState(shopId, phone, state) {
  await redis.set(keys.state(shopId, phone), JSON.stringify(state), { ex: TTL });
}

// Menu stack for back navigation
async function pushMenu(shopId, phone, menuId) {
  const raw = await redis.get(keys.menuStack(shopId, phone));
  let stack;
  if (raw && typeof raw === 'string') {
    stack = JSON.parse(raw);
  } else if (raw && typeof raw === 'object') {
    stack = raw;
  } else {
    stack = [];
  }
  stack.push(menuId);
  await redis.set(keys.menuStack(shopId, phone), JSON.stringify(stack), { ex: TTL });
}

async function popMenu(shopId, phone) {
  const raw = await redis.get(keys.menuStack(shopId, phone));
  let stack;
  if (raw && typeof raw === 'string') {
    stack = JSON.parse(raw);
  } else if (raw && typeof raw === 'object') {
    stack = raw;
  } else {
    stack = [];
  }
  stack.pop(); // remove current
  const prev = stack.length > 0 ? stack[stack.length - 1] : null;
  await redis.set(keys.menuStack(shopId, phone), JSON.stringify(stack), { ex: TTL });
  return prev;
}

// Add to conversation history for AI context
async function addHistory(shopId, phone, role, text) {
  const raw = await redis.get(keys.history(shopId, phone));
  let history;
  if (raw && typeof raw === 'string') {
    history = JSON.parse(raw);
  } else if (raw && typeof raw === 'object') {
    history = raw;
  } else {
    history = [];
  }
  history.push({ role, text: text.slice(0, 200) });
  if (history.length > 10) history.shift();
  await redis.set(keys.history(shopId, phone), JSON.stringify(history), { ex: TTL });
}

async function getHistory(shopId, phone) {
  const raw = await redis.get(keys.history(shopId, phone));
  if (raw && typeof raw === 'string') {
    return JSON.parse(raw);
  } else if (raw && typeof raw === 'object') {
    return raw;
  }
  return [];
}

// ═══════ Main Message Handler ═══════

async function handleMessage(sock, msg, shop) {
  const from = msg.key.remoteJid;
  const customerPhone = from.split('@')[0];

  try {
    const rawText = msg.message?.conversation ||
                   msg.message?.extendedTextMessage?.text ||
                   msg.message?.imageMessage?.caption ||
                   '';
    let text = rawText.trim();

    console.log(`[DEBUG] Received message: "${text}" from ${customerPhone} for shop ${shop.name}`);

    if (!text) return;
    text = normalizeNumbers(rawText).trim();

    if (!text) {
      await safeSend(sock, from, 'عذراً، أرسل رسالة نصية من فضلك 📝');
      return;
    }

    console.log(`📩 [Custom] ${shop.name} - ${customerPhone}: "${text}"`);

    const { config, menus } = await loadBotData(shop.id);
    console.log(`[DEBUG] Loaded config: ${!!config}, menus count: ${menus?.length || 0}`);
    if (!config) {
      await safeSend(sock, from, 'عذراً، البوت غير مُعد بعد. يرجى التواصل مع الإدارة.');
      return;
    }

    // Initialize custom Groq API key if available
    if (config.customGroqApiKey) {
      geminiService.initializeCustom(shop.id, config.customGroqApiKey);
    }

    const state = await getState(shop.id, customerPhone);
    const mainMenu = config.mainMenuId ? menus.find(m => m.id === config.mainMenuId) : menus[0];
    console.log(`[DEBUG] Current state:`, state);
    console.log(`[DEBUG] Main menu:`, mainMenu ? { id: mainMenu.id, name: mainMenu.name } : null);

    // Track activity
    await redis.set(keys.lastActive(shop.id, customerPhone), Date.now().toString(), { ex: TTL });
    await addHistory(shop.id, customerPhone, 'customer', text);

    // ── Navigation commands ──
    const normalized = normalizeArabic(text);
    const isBack = ['رجوع', 'رجع', 'back', 'خلف'].some(k => normalized.includes(normalizeArabic(k)));
    const isMainMenu = ['قائمة رئيسية', 'القائمة الرئيسية', 'الرئيسية', 'main', 'قائمه', 'قائمة', 'ابدا', 'ابدأ', 'start', 'menu', 'hi', 'مرحبا', 'هاي', 'السلام'].some(k => normalized.includes(normalizeArabic(k)));

    // Back navigation
    if (isBack && state.step === 'in_menu') {
      const prevMenuId = await popMenu(shop.id, customerPhone);
      if (prevMenuId) {
        const prevMenu = menus.find(m => m.id === prevMenuId);
        if (prevMenu) {
          await setState(shop.id, customerPhone, { currentMenuId: prevMenuId, step: 'in_menu', data: {} });
          const menuText = formatMenu(prevMenu);
          await safeSend(sock, from, menuText);
          await addHistory(shop.id, customerPhone, 'bot', menuText);
          return;
        }
      }
      // Fall back to main menu
      if (mainMenu) {
        await setState(shop.id, customerPhone, { currentMenuId: mainMenu.id, step: 'in_menu', data: {} });
        await redis.del(keys.menuStack(shop.id, customerPhone));
        const menuText = formatMenu(mainMenu);
        await safeSend(sock, from, menuText);
        await addHistory(shop.id, customerPhone, 'bot', menuText);
        return;
      }
    }

    // Check for technical issues (even if not in menu)
    const technicalKeywords = ['نت فاصل', 'النت مقطوع', 'انترنت شغالش', 'خدمة مقطوعة', 'مشكلة في النت', 'الدعم الفني'];
    const isTechnicalIssue = technicalKeywords.some(keyword => normalized.includes(normalizeArabic(keyword)));
    
    if (isTechnicalIssue) {
      // Find technical support menu item
      const techSupportItem = mainMenu?.items?.find(item => item.number === 5);
      if (techSupportItem) {
        return await executeAction(sock, from, shop, config, menus, state, techSupportItem, customerPhone, text);
      }
    }

    // Main menu / start / greeting
    if (isMainMenu || state.step === 'idle') {
      if (mainMenu) {
        const welcome = state.step === 'idle' ? config.welcomeMessage : '';
        await setState(shop.id, customerPhone, { currentMenuId: mainMenu.id, step: 'in_menu', data: {} });
        await redis.del(keys.menuStack(shop.id, customerPhone));
        await pushMenu(shop.id, customerPhone, mainMenu.id);
        const menuText = formatMenu(mainMenu, welcome);
        await safeSend(sock, from, menuText);
        await addHistory(shop.id, customerPhone, 'bot', menuText);
        return;
      } else {
        await safeSend(sock, from, config.welcomeMessage + '\n\nلا توجد قوائم متاحة حالياً.');
        return;
      }
    }

    // ── Order collection steps ──
    if (state.step === 'collect_name') {
      state.data.customerName = text;
      state.step = 'collect_phone';
      await setState(shop.id, customerPhone, state);
      await safeSend(sock, from, '📱 أرسل رقم هاتفك للتواصل:');
      return;
    }

    if (state.step === 'collect_phone') {
      state.data.customerPhone = text;
      
      // Handle technical support completion - no address needed
      if (state.data.isTechSupport) {
        // Send problem data to support groups
        await sendProblemToSupportGroups(shop, customerPhone, state.data.orderNotes, state.data.customerPhone);
        
        await setState(shop.id, customerPhone, { currentMenuId: null, step: 'idle', data: {} });
        await redis.del(keys.menuStack(shop.id, customerPhone));
        const confirmMsg = 'تم التواصل مع القسم المختص وهيتواصل مع حضرتك في أقرب وقت 🌹';
        await safeSend(sock, from, confirmMsg);
        await addHistory(shop.id, customerPhone, 'bot', confirmMsg);
        return;
      }

      // Skip address for booking-type orders (e.g. Archers)
      if (state.data.skipAddress) {
        try {
          const prisma = getPrisma();
          await prisma.order.create({
            data: {
              shopId: shop.id,
              customerName: state.data.customerName,
              customerPhone: state.data.customerPhone || customerPhone,
              address: 'N/A',
              totalPrice: 0,
              notes: state.data.orderNotes || 'حجز من البوت',
            },
          });
        } catch (e) {
          console.error('Order save error:', e);
        }
        // Send WhatsApp notification to management
        if (state.data.notifyPhone) {
          await sendOrderNotification(sock, shop, state.data);
        }
        await setState(shop.id, customerPhone, { currentMenuId: null, step: 'idle', data: {} });
        await redis.del(keys.menuStack(shop.id, customerPhone));
        const confirmMsg = config.orderConfirmMessage;
        await safeSend(sock, from, confirmMsg);
        await addHistory(shop.id, customerPhone, 'bot', confirmMsg);
        return;
      }
      
      // Regular order flow
      state.step = 'collect_address';
      await setState(shop.id, customerPhone, state);
      await safeSend(sock, from, '📍 أرسل عنوانك:');
      return;
    }

    if (state.step === 'collect_address') {
      state.data.address = text;
      
      // Handle technical support completion
      if (state.data.isTechSupport) {
        await setState(shop.id, customerPhone, { currentMenuId: null, step: 'idle', data: {} });
        await redis.del(keys.menuStack(shop.id, customerPhone));
        const confirmMsg = 'تم التواصل مع القسم المختص وهيتواصل مع حضرتك في أقرب وقت 🌹';
        await safeSend(sock, from, confirmMsg);
        await addHistory(shop.id, customerPhone, 'bot', confirmMsg);
        return;
      }
      
      // Save regular order
      try {
        const prisma = getPrisma();
        await prisma.order.create({
          data: {
            shopId: shop.id,
            customerName: state.data.customerName,
            customerPhone: state.data.customerPhone || customerPhone,
            address: state.data.address,
            totalPrice: 0,
            notes: state.data.orderNotes || 'طلب من البوت المخصص',
          },
        });
      } catch (e) {
        console.error('Order save error:', e);
      }
      await setState(shop.id, customerPhone, { currentMenuId: null, step: 'idle', data: {} });
      await redis.del(keys.menuStack(shop.id, customerPhone));
      const confirmMsg = config.orderConfirmMessage;
      await safeSend(sock, from, confirmMsg);
      await addHistory(shop.id, customerPhone, 'bot', confirmMsg);
      return;
    }

    // ── Menu item selection ──
    if (state.step === 'in_menu' && state.currentMenuId) {
      const currentMenu = menus.find(m => m.id === state.currentMenuId);
      if (!currentMenu) {
        console.log(`[DEBUG] Menu not found: ${state.currentMenuId}, available menus:`, menus.map(m => ({ id: m.id, name: m.name })));
        await setState(shop.id, customerPhone, { currentMenuId: null, step: 'idle', data: {} });
        await safeSend(sock, from, config.unknownMessage);
        return;
      }
      
      console.log(`[DEBUG] Current menu: ${currentMenu.name}, items:`, currentMenu.items.map(i => ({ number: i.number, label: i.label, action: i.action })));
      console.log(`[DEBUG] User input: "${text}"`);

      // Try number selection
      const num = parseInt(text);
      let selectedItem = null;

      if (!isNaN(num)) {
        selectedItem = currentMenu.items.find(item => item.number === num);
      }

      // Try fuzzy label match only for short inputs (likely menu label text, not questions)
      if (!selectedItem && text.split(/\s+/).length <= 4) {
        let bestScore = 0;
        for (const item of currentMenu.items) {
          const score = similarity(text, item.label);
          if (score > bestScore && score >= 0.85) {
            bestScore = score;
            selectedItem = item;
          }
        }
        if (selectedItem) {
          console.log(`[DEBUG] Fuzzy matched "${text}" → "${selectedItem.label}" (score: ${bestScore.toFixed(2)})`);
        }
      }

      if (selectedItem) {
        return await executeAction(sock, from, shop, config, menus, state, selectedItem, customerPhone, text);
      }

      // ── Unknown input → AI response ──
      console.log(`🤖 [AI] Generating response for "${text.slice(0, 50)}" (shop: ${shop.name})`);
      const history = await getHistory(shop.id, customerPhone);
      const historyText = history.map(h => `${h.role === 'customer' ? 'العميل' : 'البوت'}: ${h.text}`).join('\n');

      const menuItemsList = currentMenu.items.map(i => `${i.number}. ${i.label}`).join('\n');

      try {
        const aiResponse = await geminiService.getResponse(
          config.aiSystemPrompt,
          text,
          {
            shopId: shop.id,
            shopName: shop.name,
            currentMenu: currentMenu.name,
            menuItems: menuItemsList,
            sessionHistory: historyText,
          },
          {
            temperature: config.aiTemperature,
            maxTokens: config.aiMaxTokens,
            model: config.aiModel,
          }
        );

        console.log(`✅ [AI] Response (${aiResponse.length} chars): "${aiResponse.slice(0, 80)}..."`);
        await safeSend(sock, from, aiResponse);
        await addHistory(shop.id, customerPhone, 'bot', aiResponse);
      } catch (aiErr) {
        console.error(`❌ [AI] Error for "${text.slice(0, 50)}":`, aiErr.message);
        const fallbackMsg = 'عذراً، حصل مشكلة بسيطة. جرب تاني أو تواصل معنا على 01128511900 📱';
        await safeSend(sock, from, fallbackMsg);
      }
      return;
    }

    // ── Fallback: show main menu ──
    if (mainMenu) {
      await setState(shop.id, customerPhone, { currentMenuId: mainMenu.id, step: 'in_menu', data: {} });
      await redis.del(keys.menuStack(shop.id, customerPhone));
      await pushMenu(shop.id, customerPhone, mainMenu.id);
      const menuText = formatMenu(mainMenu, config.unknownMessage);
      await safeSend(sock, from, menuText);
      await addHistory(shop.id, customerPhone, 'bot', menuText);
    } else {
      await safeSend(sock, from, config.unknownMessage);
    }

  } catch (error) {
    console.error(`❌ [Custom] Error handling message for ${shop.name}:`, error);
    try {
      await safeSend(sock, from, 'عذراً، حدث خطأ. يرجى المحاولة مرة أخرى.');
    } catch (e) { /* ignore */ }
  }
}

// ═══════ Action Executor ═══════

async function executeAction(sock, from, shop, config, menus, state, item, customerPhone, text = '') {
  console.log(`[DEBUG] executeAction: item="${item.label}" action="${item.action}" actionValue="${item.actionValue || 'none'}"`);
  switch (item.action) {
    case 'custom_message': {
      const msg = item.actionValue || `✅ ${item.label}`;
      await safeSend(sock, from, msg);
      await addHistory(shop.id, customerPhone, 'bot', msg);
      break;
    }

    case 'go_to_menu': {
      const targetMenu = menus.find(m => m.id === item.actionValue);
      if (targetMenu) {
        await pushMenu(shop.id, customerPhone, targetMenu.id);
        await setState(shop.id, customerPhone, { currentMenuId: targetMenu.id, step: 'in_menu', data: {} });
        const menuText = formatMenu(targetMenu);
        await safeSend(sock, from, menuText);
        await addHistory(shop.id, customerPhone, 'bot', menuText);
      } else {
        await safeSend(sock, from, 'عذراً، القائمة غير متاحة حالياً.');
      }
      break;
    }

    case 'confirm_order': {
      // If item has custom AI prompt, use it for technical support flow
      if (item.aiPrompt && item.label.includes('الدعم الفني')) {
        const history = await getHistory(shop.id, customerPhone);
        const historyText = history.map(h => `${h.role === 'customer' ? 'العميل' : 'البوت'}: ${h.text}`).join('\n');
        
        const aiResponse = await geminiService.getResponse(
          item.aiPrompt,
          text,
          {
            shopId: shop.id,
            shopName: shop.name,
            itemContext: `${item.label} - ${item.description || ''}`,
            sessionHistory: historyText,
          },
          {
            temperature: config.aiTemperature,
            maxTokens: config.aiMaxTokens,
            model: config.aiModel,
          }
        );
        await safeSend(sock, from, aiResponse);
        await addHistory(shop.id, customerPhone, 'bot', aiResponse);
        
        // Start collection for technical support - collect customer code directly
        state.step = 'collect_phone';
        state.data = { orderNotes: item.label, isTechSupport: true };
        await setState(shop.id, customerPhone, state);
        break;
      }
      
      // Regular order flow
      state.step = 'collect_name';
      state.data = { orderNotes: item.label };
      // If actionValue contains a phone number, use it as notification target
      if (item.actionValue && /^20\d{10}$/.test(item.actionValue)) {
        state.data.notifyPhone = item.actionValue;
        state.data.skipAddress = true;
      }
      await setState(shop.id, customerPhone, state);
      await safeSend(sock, from, `✅ اخترت: *${item.label}*\n\nلإتمام الحجز، أرسل اسمك الكامل:`);
      await addHistory(shop.id, customerPhone, 'bot', 'بدأ جمع بيانات الطلب');
      break;
    }

    case 'ai_response': {
      const history = await getHistory(shop.id, customerPhone);
      const historyText = history.map(h => `${h.role === 'customer' ? 'العميل' : 'البوت'}: ${h.text}`).join('\n');

      const prompt = item.aiPrompt || config.aiSystemPrompt;
      const aiResponse = await geminiService.getResponse(
        prompt,
        `العميل اختار: ${item.label}`,
        {
          shopId: shop.id,
          shopName: shop.name,
          itemContext: `${item.label} - ${item.description || ''}`,
          sessionHistory: historyText,
        },
        {
          temperature: config.aiTemperature,
          maxTokens: config.aiMaxTokens,
          model: config.aiModel,
        }
      );
      await safeSend(sock, from, aiResponse);
      await addHistory(shop.id, customerPhone, 'bot', aiResponse);
      break;
    }

    default: {
      await safeSend(sock, from, `✅ ${item.label}`);
      break;
    }
  }
}

// Send order notification to management via WhatsApp
async function sendOrderNotification(sock, shop, orderData) {
  try {
    const notifyJid = `${orderData.notifyPhone}@s.whatsapp.net`;
    const msg = `📋 *حجز جديد من ${shop.name}* 📋

👤 *الاسم:* ${orderData.customerName}
📱 *الهاتف:* ${orderData.customerPhone}
📝 *البرنامج:* ${orderData.orderNotes}
⏰ *التوقيت:* ${new Date().toLocaleString('ar-EG')}

يرجى التواصل مع العميل لتأكيد الحجز ✅`;

    await sock.sendMessage(notifyJid, { text: msg });
    console.log(`✅ Order notification sent to ${orderData.notifyPhone} for ${shop.name}`);
  } catch (err) {
    console.error(`❌ Failed to send order notification:`, err.message);
  }
}

// Send problem data to support groups
async function sendProblemToSupportGroups(shop, customerPhone, problemType, customerCode) {
  try {
    const prisma = getPrisma();
    
    // Get active support groups for this shop
    const supportGroups = await prisma.supportGroup.findMany({
      where: { 
        shopId: shop.id, 
        isActive: true 
      }
    });
    
    if (supportGroups.length === 0) {
      console.log(`[DEBUG] No active support groups found for shop ${shop.id}`);
      return;
    }
    
    // Use the provided customer code
    
    // Format problem message
    const problemMessage = `🚨 **بلاغ مشكلة جديدة** 🚨

📋 **تفاصيل المشكلة:**
👤 **العميل:** ${customerPhone}
📱 **كود العميل:** ${customerCode}
⚠️ **نوع المشكلة:** ${problemType}
📝 **وصف المشكلة:** تم الإبلاغ عن مشكلة فنية عبر البوت

🏢 **المتجر:** ${shop.name}
⏰ **التوقيت:** ${new Date().toLocaleString('ar-EG')}

يرجى المتابعة مع العميل في أقرب وقت ممكن 🙏`;

    // Send to each support group
    for (const group of supportGroups) {
      try {
        const sock = global.whatsappSocket;
        if (!sock) {
          console.log(`[ERROR] WhatsApp socket not available for group ${group.name}`);
          continue;
        }

        await sock.sendMessage(group.groupNumber, { text: problemMessage });
        console.log(`[SUCCESS] Sent problem to support group: ${group.name} (${group.groupNumber})`);
        
      } catch (error) {
        console.error(`[ERROR] Failed to send to group ${group.name}:`, error);
      }
    }
    
    console.log(`[DEBUG] Sent problem to ${supportGroups.length} support groups`);
    
  } catch (error) {
    console.error('[ERROR] Failed to send problem to support groups:', error);
  }
}

module.exports = { handleMessage };
