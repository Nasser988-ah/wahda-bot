const express = require('express');
const router = express.Router();
const redis = require('../../db/redis');
const geminiService = require('../../services/geminiService');
const databaseService = require('../../services/databaseService');

function getPrisma() {
  return databaseService.getClient();
}

const ARCHERS_PHONE = '201101222922';
const SESSION_TTL = 3600; // 1 hour

// Keys for public chat sessions
const chatKeys = {
  history: (sessionId) => `pub:chat:history:${sessionId}`,
  state: (sessionId) => `pub:chat:state:${sessionId}`,
};

// Load bot data for Archers
async function loadArchersData() {
  const prisma = getPrisma();
  const shop = await prisma.shop.findUnique({ where: { phone: ARCHERS_PHONE } });
  if (!shop) return null;

  const [config, menus] = await Promise.all([
    prisma.botConfig.findUnique({ where: { shopId: shop.id } }),
    prisma.customMenu.findMany({
      where: { shopId: shop.id, isActive: true },
      include: { items: { orderBy: { number: 'asc' } } },
      orderBy: { order: 'asc' },
    }),
  ]);
  return { shop, config, menus };
}

// Get or init session state
async function getState(sessionId) {
  const raw = await redis.get(chatKeys.state(sessionId));
  if (raw && typeof raw === 'string') return JSON.parse(raw);
  if (raw && typeof raw === 'object') return raw;
  return { currentMenuId: null, step: 'idle', data: {} };
}

async function setState(sessionId, state) {
  await redis.set(chatKeys.state(sessionId), JSON.stringify(state), { ex: SESSION_TTL });
}

// History management
async function getHistory(sessionId) {
  const raw = await redis.get(chatKeys.history(sessionId));
  if (raw && typeof raw === 'string') return JSON.parse(raw);
  if (raw && typeof raw === 'object') return raw;
  return [];
}

async function addHistory(sessionId, role, text) {
  const history = await getHistory(sessionId);
  history.push({ role, text, ts: Date.now() });
  if (history.length > 20) history.splice(0, history.length - 20);
  await redis.set(chatKeys.history(sessionId), JSON.stringify(history), { ex: SESSION_TTL });
}

// Format menu for display
function formatMenu(menu) {
  if (!menu || !menu.items || menu.items.length === 0) return null;
  let text = `📋 *${menu.name}*\n\n`;
  menu.items.forEach(item => {
    text += `${item.number}. ${item.label}\n`;
  });
  text += '\n💡 اختر رقم الخيار';
  return text;
}

// Normalize Arabic
function normalizeArabic(text) {
  return text
    .replace(/أ|إ|آ/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/ّ|َ|ُ|ِ|ْ|ً|ٌ|ٍ/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

// Normalize numbers
function normalizeNumbers(text) {
  const map = { '٠':'0','١':'1','٢':'2','٣':'3','٤':'4','٥':'5','٦':'6','٧':'7','٨':'8','٩':'9' };
  return text.replace(/[٠-٩]/g, d => map[d] || d);
}

// POST /api/public/archers/chat
router.post('/archers/chat', async (req, res) => {
  try {
    const { message, sessionId } = req.body;
    if (!message || !sessionId) {
      return res.status(400).json({ error: 'message and sessionId required' });
    }

    const text = normalizeNumbers(message.trim());
    if (!text) return res.status(400).json({ error: 'empty message' });

    const data = await loadArchersData();
    if (!data || !data.config) {
      return res.status(503).json({ error: 'Bot not configured yet' });
    }

    const { shop, config, menus } = data;
    const state = await getState(sessionId);
    const mainMenu = config.mainMenuId ? menus.find(m => m.id === config.mainMenuId) : menus[0];

    await addHistory(sessionId, 'customer', text);

    const normalized = normalizeArabic(text);
    const isMainMenu = ['قائمه', 'قائمة', 'menu', 'قائمة رئيسية', 'القائمة الرئيسية', 'ابدا', 'start'].some(k => normalized.includes(normalizeArabic(k)));
    const isBack = ['رجوع', 'رجع', 'back', 'خلف'].some(k => normalized.includes(normalizeArabic(k)));

    // Back navigation
    if (isBack && state.step === 'in_menu' && mainMenu) {
      await setState(sessionId, { currentMenuId: mainMenu.id, step: 'in_menu', data: {} });
      const menuText = formatMenu(mainMenu);
      await addHistory(sessionId, 'bot', menuText);
      return res.json({ response: menuText, type: 'menu' });
    }

    // Show main menu
    if (isMainMenu || state.step === 'idle') {
      if (mainMenu) {
        const welcome = state.step === 'idle' ? config.welcomeMessage + '\n\n' : '';
        await setState(sessionId, { currentMenuId: mainMenu.id, step: 'in_menu', data: {} });
        const menuText = welcome + formatMenu(mainMenu);
        await addHistory(sessionId, 'bot', menuText);
        return res.json({ response: menuText, type: 'menu' });
      }
    }

    // Order collection: name
    if (state.step === 'collect_name') {
      state.data.customerName = text;
      state.step = 'collect_phone';
      await setState(sessionId, state);
      const msg = '📱 أرسل رقم هاتفك للتواصل:';
      await addHistory(sessionId, 'bot', msg);
      return res.json({ response: msg, type: 'collect' });
    }

    // Order collection: phone
    if (state.step === 'collect_phone') {
      state.data.customerPhone = text;
      // Save order
      try {
        const prisma = getPrisma();
        await prisma.order.create({
          data: {
            shopId: shop.id,
            customerName: state.data.customerName,
            customerPhone: state.data.customerPhone,
            address: 'N/A - Web Chat',
            totalPrice: 0,
            notes: state.data.orderNotes || 'حجز من صفحة الويب',
          },
        });
      } catch (e) {
        console.error('Public chat order save error:', e);
      }
      // Send WhatsApp notification
      try {
        const sock = global.whatsappSocket;
        if (sock && state.data.notifyPhone) {
          const notifyJid = `${state.data.notifyPhone}@s.whatsapp.net`;
          const notifMsg = `📋 *حجز جديد من الموقع - ${shop.name}* 📋\n\n👤 *الاسم:* ${state.data.customerName}\n📱 *الهاتف:* ${state.data.customerPhone}\n📝 *البرنامج:* ${state.data.orderNotes}\n⏰ *التوقيت:* ${new Date().toLocaleString('ar-EG')}\n\nيرجى التواصل مع العميل لتأكيد الحجز ✅`;
          await sock.sendMessage(notifyJid, { text: notifMsg });
          console.log(`✅ Web chat order notification sent to ${state.data.notifyPhone}`);
        }
      } catch (e) {
        console.error('Notification error:', e.message);
      }
      await setState(sessionId, { currentMenuId: null, step: 'idle', data: {} });
      const confirmMsg = config.orderConfirmMessage;
      await addHistory(sessionId, 'bot', confirmMsg);
      return res.json({ response: confirmMsg, type: 'confirm' });
    }

    // Menu item selection
    if (state.step === 'in_menu' && state.currentMenuId) {
      const currentMenu = menus.find(m => m.id === state.currentMenuId);
      if (!currentMenu) {
        await setState(sessionId, { currentMenuId: null, step: 'idle', data: {} });
        return res.json({ response: config.unknownMessage, type: 'text' });
      }

      const num = parseInt(text);
      let selectedItem = null;
      if (!isNaN(num)) {
        selectedItem = currentMenu.items.find(i => i.number === num);
      }

      if (selectedItem) {
        console.log(`[PUB-CHAT] Selected: "${selectedItem.label}" action=${selectedItem.action}`);

        switch (selectedItem.action) {
          case 'go_to_menu': {
            const targetMenu = menus.find(m => m.id === selectedItem.actionValue);
            if (targetMenu) {
              await setState(sessionId, { currentMenuId: targetMenu.id, step: 'in_menu', data: {} });
              const menuText = formatMenu(targetMenu);
              await addHistory(sessionId, 'bot', menuText);
              return res.json({ response: menuText, type: 'menu' });
            }
            break;
          }
          case 'confirm_order': {
            const orderState = {
              currentMenuId: state.currentMenuId,
              step: 'collect_name',
              data: { orderNotes: selectedItem.label }
            };
            if (selectedItem.actionValue && /^20\d{10}$/.test(selectedItem.actionValue)) {
              orderState.data.notifyPhone = selectedItem.actionValue;
            }
            await setState(sessionId, orderState);
            const msg = `✅ اخترت: *${selectedItem.label}*\n\nلإتمام الحجز، أرسل اسمك الكامل:`;
            await addHistory(sessionId, 'bot', msg);
            return res.json({ response: msg, type: 'collect' });
          }
          case 'custom_message': {
            const msg = selectedItem.actionValue || `✅ ${selectedItem.label}`;
            await addHistory(sessionId, 'bot', msg);
            return res.json({ response: msg, type: 'text' });
          }
          case 'ai_response': {
            const history = await getHistory(sessionId);
            const historyText = history.slice(-10).map(h => `${h.role === 'customer' ? 'العميل' : 'البوت'}: ${h.text}`).join('\n');
            const prompt = selectedItem.aiPrompt || config.aiSystemPrompt;
            const aiResponse = await geminiService.getResponse(
              prompt,
              `العميل اختار: ${selectedItem.label}`,
              { shopId: shop.id, shopName: shop.name, itemContext: selectedItem.label, sessionHistory: historyText },
              { temperature: config.aiTemperature, maxTokens: config.aiMaxTokens, model: config.aiModel }
            );
            await addHistory(sessionId, 'bot', aiResponse);
            return res.json({ response: aiResponse, type: 'ai' });
          }
        }
      }

      // No menu item matched → AI response
      const history = await getHistory(sessionId);
      const historyText = history.slice(-10).map(h => `${h.role === 'customer' ? 'العميل' : 'البوت'}: ${h.text}`).join('\n');
      const menuItemsList = currentMenu.items.map(i => `${i.number}. ${i.label}`).join('\n');
      const aiResponse = await geminiService.getResponse(
        config.aiSystemPrompt,
        text,
        { shopId: shop.id, shopName: shop.name, currentMenu: currentMenu.name, menuItems: menuItemsList, sessionHistory: historyText },
        { temperature: config.aiTemperature, maxTokens: config.aiMaxTokens, model: config.aiModel }
      );
      await addHistory(sessionId, 'bot', aiResponse);
      return res.json({ response: aiResponse, type: 'ai' });
    }

    // Fallback
    if (mainMenu) {
      await setState(sessionId, { currentMenuId: mainMenu.id, step: 'in_menu', data: {} });
      const menuText = formatMenu(mainMenu);
      await addHistory(sessionId, 'bot', menuText);
      return res.json({ response: menuText, type: 'menu' });
    }

    return res.json({ response: config.unknownMessage, type: 'text' });
  } catch (error) {
    console.error('Public chat error:', error);
    res.status(500).json({ error: 'حدث خطأ، حاول مرة أخرى' });
  }
});

// GET /api/public/archers/welcome - get initial welcome + menu
router.get('/archers/welcome', async (req, res) => {
  try {
    const data = await loadArchersData();
    if (!data || !data.config) {
      return res.status(503).json({ error: 'Bot not configured' });
    }
    const { config, menus } = data;
    const mainMenu = config.mainMenuId ? menus.find(m => m.id === config.mainMenuId) : menus[0];
    let welcome = config.welcomeMessage;
    if (mainMenu) {
      welcome += '\n\n' + formatMenu(mainMenu);
    }
    res.json({ welcome, shopName: data.shop.name });
  } catch (error) {
    console.error('Public welcome error:', error);
    res.status(500).json({ error: 'Service error' });
  }
});

module.exports = router;
