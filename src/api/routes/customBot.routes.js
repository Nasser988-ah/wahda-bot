const express = require('express');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const { authenticateToken } = require('../middleware/auth.middleware');
const { authenticateAdmin } = require('../middleware/admin.middleware');
const databaseService = require('../../services/databaseService');
const geminiService = require('../../services/geminiService');
const redis = require('../../db/redis');

const router = express.Router();

function getPrisma() {
  if (!databaseService.isConnected) {
    throw new Error('Database is not configured');
  }
  return databaseService.getClient();
}

// ═══════ PUBLIC: Custom Bot Request ═══════

const requestSchema = z.object({
  companyName: z.string().min(2),
  industry: z.string().min(2),
  phone: z.string().min(10),
  message: z.string().min(5),
});

// Submit a custom bot request (public, no auth)
router.post('/request', async (req, res) => {
  try {
    const prisma = getPrisma();
    const validation = requestSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ error: 'بيانات غير صالحة', details: validation.error.errors });
    }

    const request = await prisma.customBotRequest.create({
      data: validation.data,
    });

    res.status(201).json({ success: true, message: 'تم إرسال طلبك بنجاح! سيتم التواصل معك خلال 24 ساعة.', id: request.id });
  } catch (error) {
    console.error('Custom bot request error:', error);
    res.status(500).json({ error: 'فشل في إرسال الطلب' });
  }
});

// ═══════ ADMIN: Manage Custom Bot Requests ═══════

// Get all requests (admin)
router.get('/requests', authenticateAdmin, async (req, res) => {
  try {
    const prisma = getPrisma();
    const { status } = req.query;
    const where = status ? { status } : {};

    const requests = await prisma.customBotRequest.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });

    res.json({ requests });
  } catch (error) {
    console.error('Get custom bot requests error:', error);
    res.status(500).json({ error: 'فشل في تحميل الطلبات' });
  }
});

// Approve request (admin) - creates shop account
router.post('/requests/:id/approve', authenticateAdmin, async (req, res) => {
  try {
    const prisma = getPrisma();
    const { botType } = req.body;

    if (!botType) {
      return res.status(400).json({ error: 'يجب اختيار نوع البوت' });
    }

    const request = await prisma.customBotRequest.findUnique({
      where: { id: req.params.id },
    });

    if (!request) {
      return res.status(404).json({ error: 'الطلب غير موجود' });
    }

    if (request.status !== 'pending') {
      return res.status(400).json({ error: 'تم معالجة هذا الطلب مسبقاً' });
    }

    // Generate a temporary password
    const tempPassword = Math.random().toString(36).slice(-8) + 'A1!';
    const hashedPassword = await bcrypt.hash(tempPassword, 10);

    // Normalize phone for use as unique identifier
    let normalizedPhone = request.phone.replace(/\s+/g, '').replace(/^0/, '20');
    if (!normalizedPhone.startsWith('20')) {
      normalizedPhone = '20' + normalizedPhone;
    }

    // Create or reuse shop account (idempotent for retries)
    let shop = await prisma.shop.findUnique({ where: { phone: normalizedPhone } });
    if (!shop) {
      shop = await prisma.shop.create({
        data: {
          name: request.companyName,
          ownerName: request.companyName,
          phone: normalizedPhone,
          whatsappNumber: normalizedPhone,
          shopType: 'custom',
          botType: botType,
          password: hashedPassword,
          subscriptionStatus: 'ACTIVE',
          subscriptionEnd: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 1 year
        },
      });
    } else {
      // Update existing shop with new password
      await prisma.shop.update({
        where: { id: shop.id },
        data: { password: hashedPassword, shopType: 'custom', botType },
      });
    }

    // Create or update admin record for login
    await prisma.admin.upsert({
      where: { email: `${normalizedPhone}@wahdabot.com` },
      update: { password: hashedPassword },
      create: {
        email: `${normalizedPhone}@wahdabot.com`,
        password: hashedPassword,
      },
    });

    // Create default bot config (skip if already exists)
    const defaultWelcome = botType === 'isp'
      ? `مرحباً بك في ${request.companyName}! 🌐\n\nنحن هنا لخدمتك. اختر من القائمة أدناه:`
      : `مرحباً بك في ${request.companyName}!\n\nاختر من القائمة:`;

    await prisma.botConfig.upsert({
      where: { shopId: shop.id },
      update: {},
      create: {
        shopId: shop.id,
        welcomeMessage: defaultWelcome,
        unknownMessage: 'عذراً، لم أفهم طلبك. يرجى اختيار رقم من القائمة أو كتابة "قائمة" للعودة.',
        orderConfirmMessage: 'تم تأكيد طلبك بنجاح! ✅\nسيتم التواصل معك قريباً.',
        aiSystemPrompt: `أنت موظف خدمة عملاء محترف في ${request.companyName}. أجب بلغة عربية فصحى مختصرة ومهنية.`,
        aiProvider: botType === 'isp' ? 'gemini' : 'groq',
        aiModel: botType === 'isp' ? 'gemini-2.0-flash' : 'llama-3.3-70b-versatile',
      },
    });

    // Update request status
    await prisma.customBotRequest.update({
      where: { id: req.params.id },
      data: { status: 'approved', botType },
    });

    res.json({
      success: true,
      message: 'تم قبول الطلب وإنشاء الحساب',
      shop: { id: shop.id, name: shop.name, phone: normalizedPhone },
      tempPassword,
    });
  } catch (error) {
    console.error('Approve request error:', error);
    res.status(500).json({ error: 'فشل في قبول الطلب' });
  }
});

// Reject request (admin)
router.post('/requests/:id/reject', authenticateAdmin, async (req, res) => {
  try {
    const prisma = getPrisma();
    const { note } = req.body;

    const request = await prisma.customBotRequest.findUnique({
      where: { id: req.params.id },
    });

    if (!request) {
      return res.status(404).json({ error: 'الطلب غير موجود' });
    }

    await prisma.customBotRequest.update({
      where: { id: req.params.id },
      data: { status: 'rejected', adminNote: note || null },
    });

    res.json({ success: true, message: 'تم رفض الطلب' });
  } catch (error) {
    console.error('Reject request error:', error);
    res.status(500).json({ error: 'فشل في رفض الطلب' });
  }
});

// ═══════ CUSTOM BOT CLIENT: Bot Config ═══════

// Get bot config
router.get('/config', authenticateToken, async (req, res) => {
  try {
    const prisma = getPrisma();
    const config = await prisma.botConfig.findUnique({
      where: { shopId: req.shop.id },
    });

    if (!config) {
      return res.status(404).json({ error: 'لم يتم إعداد البوت بعد' });
    }

    res.json(config);
  } catch (error) {
    console.error('Get bot config error:', error);
    res.status(500).json({ error: 'فشل في تحميل الإعدادات' });
  }
});

// Update bot config
router.put('/config', authenticateToken, async (req, res) => {
  try {
    const prisma = getPrisma();
    const { welcomeMessage, unknownMessage, orderConfirmMessage, aiSystemPrompt, formalityLevel, mainMenuId } = req.body;

    const data = {};
    if (welcomeMessage !== undefined) data.welcomeMessage = welcomeMessage;
    if (unknownMessage !== undefined) data.unknownMessage = unknownMessage;
    if (orderConfirmMessage !== undefined) data.orderConfirmMessage = orderConfirmMessage;
    if (aiSystemPrompt !== undefined) data.aiSystemPrompt = aiSystemPrompt;
    if (formalityLevel !== undefined) data.formalityLevel = parseInt(formalityLevel);
    if (mainMenuId !== undefined) data.mainMenuId = mainMenuId;

    const config = await prisma.botConfig.update({
      where: { shopId: req.shop.id },
      data,
    });

    res.json({ success: true, config });
  } catch (error) {
    console.error('Update bot config error:', error);
    res.status(500).json({ error: 'فشل في حفظ الإعدادات' });
  }
});

// ═══════ CUSTOM BOT CLIENT: AI Settings ═══════

// Update AI settings
router.put('/ai-settings', authenticateToken, async (req, res) => {
  try {
    const prisma = getPrisma();
    const { aiTemperature, aiMaxTokens, aiSystemPrompt } = req.body;

    const data = {};
    if (aiTemperature !== undefined) data.aiTemperature = parseFloat(aiTemperature);
    if (aiMaxTokens !== undefined) data.aiMaxTokens = parseInt(aiMaxTokens);
    if (aiSystemPrompt !== undefined) data.aiSystemPrompt = aiSystemPrompt;

    const config = await prisma.botConfig.update({
      where: { shopId: req.shop.id },
      data,
    });

    res.json({ success: true, config });
  } catch (error) {
    console.error('Update AI settings error:', error);
    res.status(500).json({ error: 'فشل في حفظ إعدادات الذكاء الاصطناعي' });
  }
});

// Test AI response
router.post('/ai-test', authenticateToken, async (req, res) => {
  try {
    const prisma = getPrisma();
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'يرجى كتابة رسالة للاختبار' });
    }

    // Use a test session key (since we don't have a real customer phone in test)
    const testSessionKey = `ai-test:${req.shop.id}`;
    const MEMORY_TTL = 86400; // 24 hours

    const [config, menus] = await Promise.all([
      prisma.botConfig.findUnique({ where: { shopId: req.shop.id } }),
      prisma.customMenu.findMany({
        where: { shopId: req.shop.id, isActive: true },
        include: { items: { orderBy: { number: 'asc' } } },
        orderBy: { order: 'asc' },
      }),
    ]);

    if (!config) {
      return res.status(404).json({ error: 'لم يتم إعداد البوت بعد' });
    }

    // Build menu context so AI knows the full bot setup
    let menuContext = '';
    if (menus.length > 0) {
      menuContext = menus.map(m => {
        const items = (m.items || []).map(i => {
          const price = i.price ? ` (${i.price} ج.م)` : '';
          return `  ${i.number}. ${i.label}${price}`;
        }).join('\n');
        const isMain = m.id === config.mainMenuId ? ' [القائمة الرئيسية]' : '';
        return `📋 ${m.name}${isMain}:\n${items}`;
      }).join('\n\n');
    }

    // Check if user is testing a specific AI response menu item
    let aiPrompt = config.aiSystemPrompt || '';
    let itemContext = '';
    
    // Load existing memory
    let memory = await redis.get(testSessionKey);
    if (memory && typeof memory === 'string') {
      memory = JSON.parse(memory);
    } else if (memory && typeof memory === 'object') {
      // Already parsed
    } else {
      memory = { phone: null, selectedProducts: [], lastUpdated: Date.now() };
    }

    // Extract phone number from message
    const phoneRegex = /(?:01|00966|\+966|0)?([0-9]{9,15})/g;
    const phoneMatch = message.match(phoneRegex);
    if (phoneMatch && !memory.phone) {
      memory.phone = phoneMatch[0];
      await redis.set(testSessionKey, JSON.stringify(memory), { ex: MEMORY_TTL });
    }

    // Extract product selections (numbers that match menu items)
    const numberRegex = /\b(\d+)\b/g;
    const numbers = message.match(numberRegex) || [];
    for (const num of numbers) {
      const itemNum = parseInt(num);
      for (const menu of menus) {
        const item = (menu.items || []).find(i => i.number === itemNum);
        if (item && !memory.selectedProducts.find(p => p.number === itemNum)) {
          memory.selectedProducts.push({
            number: item.number,
            label: item.label,
            price: item.price,
            menuName: menu.name,
            timestamp: Date.now()
          });
          await redis.set(testSessionKey, JSON.stringify(memory), { ex: MEMORY_TTL });
          break;
        }
      }
    }

    // Try to match message to an AI response menu item
    for (const menu of menus) {
      for (const item of menu.items || []) {
        if (item.action === 'ai_response') {
          // Simple matching: check if message contains the item label or number
          const normalizedMsg = message.toLowerCase().replace(/[^\u0600-\u06FF0-9\s]/g, '');
          const normalizedLabel = item.label.toLowerCase().replace(/[^\u0600-\u06FF0-9\s]/g, '');
          const itemNum = item.number.toString();
          
          if (normalizedMsg.includes(normalizedLabel) || normalizedMsg.includes(itemNum)) {
            aiPrompt = item.aiPrompt || config.aiSystemPrompt || '';
            itemContext = `${item.label} - ${item.description || ''}`;
            break;
          }
        }
      }
      if (itemContext) break;
    }

    // Build a rich system prompt with memory context
    let fullSystemPrompt = aiPrompt;
    fullSystemPrompt += `\n\nرسالة الترحيب: ${config.welcomeMessage || ''}`;
    fullSystemPrompt += `\nرسالة عند عدم الفهم: ${config.unknownMessage || ''}`;
    
    // Add memory context
    if (memory.phone) {
      fullSystemPrompt += `\n\nرقم هاتف العميل المحفوظ: ${memory.phone}`;
    }
    if (memory.selectedProducts.length > 0) {
      const productsList = memory.selectedProducts.map(p => `- ${p.label} (${p.price ? p.price + ' ج.م' : 'لا يوجد سعر'})`).join('\n');
      fullSystemPrompt += `\n\nالمنتجات التي اختارها العميل سابقاً:\n${productsList}`;
      fullSystemPrompt += `\n\nتذكر هذه الاختيارات عند الإجابة على أسئلة العميل.`;
    }
    
    if (menuContext) {
      fullSystemPrompt += `\n\nالقوائم المتاحة:\n${menuContext}`;
      fullSystemPrompt += `\n\nاستخدم هذه القوائم والأسعار عند الإجابة على أسئلة العميل.`;
    }

    const response = await geminiService.getResponse(
      fullSystemPrompt,
      message,
      { shopName: req.shop.name, itemContext, memory },
      { temperature: config.aiTemperature, maxTokens: config.aiMaxTokens, model: config.aiModel }
    );

    res.json({ success: true, response });
  } catch (error) {
    console.error('AI test error:', error);
    res.status(500).json({ error: 'فشل في اختبار الذكاء الاصطناعي' });
  }
});

// Clear AI test memory
router.post('/ai-test/clear-memory', authenticateToken, async (req, res) => {
  try {
    const testSessionKey = `ai-test:${req.shop.id}`;
    await redis.del(testSessionKey);
    res.json({ success: true, message: 'تم مسح الذاكرة بنجاح' });
  } catch (error) {
    console.error('Clear memory error:', error);
    res.status(500).json({ error: 'فشل في مسح الذاكرة' });
  }
});

// View AI test memory
router.get('/ai-test/memory', authenticateToken, async (req, res) => {
  try {
    const testSessionKey = `ai-test:${req.shop.id}`;
    const memory = await redis.get(testSessionKey);
    let parsedMemory;
    if (memory && typeof memory === 'string') {
      parsedMemory = JSON.parse(memory);
    } else if (memory && typeof memory === 'object') {
      parsedMemory = memory;
    } else {
      parsedMemory = { phone: null, selectedProducts: [], lastUpdated: null };
    }
    res.json({ memory: parsedMemory });
  } catch (error) {
    console.error('Get memory error:', error);
    res.status(500).json({ error: 'فشل في جلب الذاكرة' });
  }
});

// ═══════ CUSTOM BOT CLIENT: Menus ═══════

// Get all menus for this shop
router.get('/menus', authenticateToken, async (req, res) => {
  try {
    const prisma = getPrisma();
    const menus = await prisma.customMenu.findMany({
      where: { shopId: req.shop.id },
      include: { items: { orderBy: { number: 'asc' } } },
      orderBy: { order: 'asc' },
    });

    res.json({ menus });
  } catch (error) {
    console.error('Get menus error:', error);
    res.status(500).json({ error: 'فشل في تحميل القوائم' });
  }
});

// Create a menu
router.post('/menus', authenticateToken, async (req, res) => {
  try {
    const prisma = getPrisma();
    const { name, description } = req.body;

    // Check max 10 menus
    const count = await prisma.customMenu.count({ where: { shopId: req.shop.id } });
    if (count >= 10) {
      return res.status(400).json({ error: 'الحد الأقصى 10 قوائم' });
    }

    const menu = await prisma.customMenu.create({
      data: {
        shopId: req.shop.id,
        name: name || 'قائمة جديدة',
        description: description || null,
        order: count,
      },
      include: { items: true },
    });

    res.status(201).json({ success: true, menu });
  } catch (error) {
    console.error('Create menu error:', error);
    res.status(500).json({ error: 'فشل في إنشاء القائمة' });
  }
});

// Update a menu
router.put('/menus/:id', authenticateToken, async (req, res) => {
  try {
    const prisma = getPrisma();
    const { name, description, isActive, order } = req.body;

    const existing = await prisma.customMenu.findFirst({
      where: { id: req.params.id, shopId: req.shop.id },
    });
    if (!existing) return res.status(404).json({ error: 'القائمة غير موجودة' });

    const data = {};
    if (name !== undefined) data.name = name;
    if (description !== undefined) data.description = description;
    if (isActive !== undefined) data.isActive = isActive;
    if (order !== undefined) data.order = parseInt(order);

    const menu = await prisma.customMenu.update({
      where: { id: req.params.id },
      data,
      include: { items: { orderBy: { number: 'asc' } } },
    });

    res.json({ success: true, menu });
  } catch (error) {
    console.error('Update menu error:', error);
    res.status(500).json({ error: 'فشل في تحديث القائمة' });
  }
});

// Delete a menu
router.delete('/menus/:id', authenticateToken, async (req, res) => {
  try {
    const prisma = getPrisma();
    const existing = await prisma.customMenu.findFirst({
      where: { id: req.params.id, shopId: req.shop.id },
    });
    if (!existing) return res.status(404).json({ error: 'القائمة غير موجودة' });

    await prisma.customMenu.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (error) {
    console.error('Delete menu error:', error);
    res.status(500).json({ error: 'فشل في حذف القائمة' });
  }
});

// Set main menu
router.put('/menus/:id/set-main', authenticateToken, async (req, res) => {
  try {
    const prisma = getPrisma();
    const existing = await prisma.customMenu.findFirst({
      where: { id: req.params.id, shopId: req.shop.id },
    });
    if (!existing) return res.status(404).json({ error: 'القائمة غير موجودة' });

    await prisma.botConfig.update({
      where: { shopId: req.shop.id },
      data: { mainMenuId: req.params.id },
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Set main menu error:', error);
    res.status(500).json({ error: 'فشل في تعيين القائمة الرئيسية' });
  }
});

// ═══════ CUSTOM BOT CLIENT: Menu Items ═══════

// Add item to menu
router.post('/menus/:menuId/items', authenticateToken, async (req, res) => {
  try {
    const prisma = getPrisma();
    const { number, label, price, description, action, actionValue, aiPrompt } = req.body;

    const menu = await prisma.customMenu.findFirst({
      where: { id: req.params.menuId, shopId: req.shop.id },
      include: { items: true },
    });
    if (!menu) return res.status(404).json({ error: 'القائمة غير موجودة' });

    if (menu.items.length >= 20) {
      return res.status(400).json({ error: 'الحد الأقصى 20 عنصر لكل قائمة' });
    }

    const itemNumber = number || (menu.items.length + 1);

    const item = await prisma.customMenuItem.create({
      data: {
        menuId: req.params.menuId,
        number: itemNumber,
        label: label || 'عنصر جديد',
        price: price ? parseFloat(price) : null,
        description: description || null,
        action: action || 'custom_message',
        actionValue: actionValue || null,
        aiPrompt: aiPrompt || null,
      },
    });

    res.status(201).json({ success: true, item });
  } catch (error) {
    console.error('Add menu item error:', error);
    res.status(500).json({ error: 'فشل في إضافة العنصر' });
  }
});

// Update menu item
router.put('/menu-items/:id', authenticateToken, async (req, res) => {
  try {
    const prisma = getPrisma();
    const { number, label, price, description, action, actionValue, aiPrompt } = req.body;

    // Verify ownership through menu -> shop
    const item = await prisma.customMenuItem.findUnique({
      where: { id: req.params.id },
      include: { menu: true },
    });
    if (!item || item.menu.shopId !== req.shop.id) {
      return res.status(404).json({ error: 'العنصر غير موجود' });
    }

    const data = {};
    if (number !== undefined) data.number = parseInt(number);
    if (label !== undefined) data.label = label;
    if (price !== undefined) data.price = price !== null ? parseFloat(price) : null;
    if (description !== undefined) data.description = description;
    if (action !== undefined) data.action = action;
    if (actionValue !== undefined) data.actionValue = actionValue;
    if (aiPrompt !== undefined) data.aiPrompt = aiPrompt;

    const updated = await prisma.customMenuItem.update({
      where: { id: req.params.id },
      data,
    });

    res.json({ success: true, item: updated });
  } catch (error) {
    console.error('Update menu item error:', error);
    res.status(500).json({ error: 'فشل في تحديث العنصر' });
  }
});

// Delete menu item
router.delete('/menu-items/:id', authenticateToken, async (req, res) => {
  try {
    const prisma = getPrisma();
    const item = await prisma.customMenuItem.findUnique({
      where: { id: req.params.id },
      include: { menu: true },
    });
    if (!item || item.menu.shopId !== req.shop.id) {
      return res.status(404).json({ error: 'العنصر غير موجود' });
    }

    await prisma.customMenuItem.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (error) {
    console.error('Delete menu item error:', error);
    res.status(500).json({ error: 'فشل في حذف العنصر' });
  }
});

module.exports = router;
