const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth.middleware');
const databaseService = require('../../services/databaseService');

// Get all support groups for a shop
router.get('/', authenticateToken, async (req, res) => {
  try {
    console.log('[DEBUG] Getting support groups for shop:', req.shop?.id);
    const prisma = databaseService.getClient();
    const groups = await prisma.supportGroup.findMany({
      where: { shopId: req.shop.id },
      orderBy: { createdAt: 'desc' }
    });
    
    console.log('[DEBUG] Found groups:', groups.length);
    res.json({ success: true, data: groups });
  } catch (error) {
    console.error('[ERROR] Get support groups error:', error);
    res.status(500).json({ success: false, error: 'فشل في جلب مجموعات الدعم' });
  }
});

// Create new support group
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { name, groupLink, groupNumber } = req.body;
    
    if (!name || !groupLink || !groupNumber) {
      return res.status(400).json({ 
        success: false, 
        error: 'يرجى ملء جميع الحقول المطلوبة' 
      });
    }

    const prisma = databaseService.getClient();
    const group = await prisma.supportGroup.create({
      data: {
        shopId: req.shop.id,
        name,
        groupLink,
        groupNumber
      }
    });

    res.json({ success: true, data: group });
  } catch (error) {
    console.error('Create support group error:', error);
    res.status(500).json({ success: false, error: 'فشل في إنشاء مجموعة الدعم' });
  }
});

// Update support group
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, groupLink, groupNumber, isActive } = req.body;

    const prisma = databaseService.getClient();
    
    // Verify group belongs to this shop
    const existingGroup = await prisma.supportGroup.findFirst({
      where: { id, shopId: req.shop.id }
    });

    if (!existingGroup) {
      return res.status(404).json({ 
        success: false, 
        error: 'مجموعة الدعم غير موجودة' 
      });
    }

    const group = await prisma.supportGroup.update({
      where: { id },
      data: {
        name,
        groupLink,
        groupNumber,
        isActive: isActive !== undefined ? isActive : existingGroup.isActive
      }
    });

    res.json({ success: true, data: group });
  } catch (error) {
    console.error('Update support group error:', error);
    res.status(500).json({ success: false, error: 'فشل في تحديث مجموعة الدعم' });
  }
});

// Delete support group
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const prisma = databaseService.getClient();
    
    // Verify group belongs to this shop
    const existingGroup = await prisma.supportGroup.findFirst({
      where: { id, shopId: req.shop.id }
    });

    if (!existingGroup) {
      return res.status(404).json({ 
        success: false, 
        error: 'مجموعة الدعم غير موجودة' 
      });
    }

    await prisma.supportGroup.delete({
      where: { id }
    });

    res.json({ success: true, message: 'تم حذف مجموعة الدعم بنجاح' });
  } catch (error) {
    console.error('Delete support group error:', error);
    res.status(500).json({ success: false, error: 'فشل في حذف مجموعة الدعم' });
  }
});

// Send problem data to support group
router.post('/send-problem/:groupId', authenticateToken, async (req, res) => {
  try {
    const { groupId } = req.params;
    const { customerName, customerPhone, problemDescription, priority } = req.body;

    if (!customerName || !customerPhone || !problemDescription) {
      return res.status(400).json({ 
        success: false, 
        error: 'يرجى توفير جميع بيانات المشكلة' 
      });
    }

    const prisma = databaseService.getClient();
    
    // Get group details
    const group = await prisma.supportGroup.findFirst({
      where: { id: groupId, shopId: req.shop.id, isActive: true }
    });

    if (!group) {
      return res.status(404).json({ 
        success: false, 
        error: 'مجموعة الدعم غير موجودة أو غير نشطة' 
      });
    }

    // Format problem message
    const problemMessage = `🚨 **بلاغ مشكلة جديدة** 🚨

📋 **تفاصيل المشكلة:**
👤 **العميل:** ${customerName}
📱 **رقم الهاتف:** ${customerPhone}
⚠️ **الأولوية:** ${priority || 'عادية'}
📝 **وصف المشكلة:** ${problemDescription}

🏢 **المتجر:** ${req.shop.name}
⏰ **التوقيت:** ${new Date().toLocaleString('ar-EG')}

يرجى المتابعة مع العميل في أقرب وقت ممكن 🙏`;

    // Send to WhatsApp group
    try {
      const sock = global.whatsappSocket;
      console.log('[DEBUG] Global socket check:', !!sock);
      
      if (!sock) {
        console.log('[ERROR] WhatsApp socket not available. Global socket is null/undefined');
        return res.status(503).json({ 
          success: false, 
          error: 'خدمة WhatsApp غير متاحة حالياً. يرجى التأكد من اتصال البوت.' 
        });
      }

      // Simple connection check - if socket has user, it's connected
      const isConnected = !!sock.user;
      console.log('[DEBUG] Socket connection status:', isConnected);
      console.log('[DEBUG] Socket user:', !!sock.user);
      console.log('[DEBUG] Socket keys:', Object.keys(sock));
      
      if (!isConnected) {
        console.log('[ERROR] WhatsApp socket exists but not connected');
        return res.status(503).json({ 
          success: false, 
          error: 'خدمة WhatsApp غير متصلة حالياً. يرجى الانتظار حتى يتم الاتصال.' 
        });
      }

      // Debug group info
      console.log(`[DEBUG] Group info:`, {
        id: group.id,
        name: group.name,
        groupNumber: group.groupNumber,
        isActive: group.isActive
      });

      // Validate group number format
      const groupJid = group.groupNumber.trim();
      console.log(`[DEBUG] Sending to group JID: ${groupJid}`);
      
      // Check if it's a valid WhatsApp group JID format
      if (!groupJid.includes('@g.us') && !groupJid.includes('@s.whatsapp.net')) {
        console.log(`[ERROR] Invalid group format: ${groupJid}. Expected format: 1234567890@g.us or 1234567890-1234567890@g.us`);
        return res.status(400).json({ 
          success: false, 
          error: `تنسيق رقم المجموعة غير صحيح: ${groupJid}. يرجى استخدام التنسيق الصحيح: 1234567890@g.us` 
        });
      }

      await sock.sendMessage(groupJid, { text: problemMessage });
      console.log(`[SUCCESS] Sent problem to support group: ${group.name} (${groupJid})`);
      
    } catch (error) {
      console.error(`[ERROR] Failed to send to group ${group.name}:`, error);
      return res.status(500).json({ 
        success: false, 
        error: `فشل في إرسال الرسالة: ${error.message}` 
      });
    }

    res.json({ 
      success: true, 
      message: 'تم إرسال بيانات المشكلة إلى مجموعة الدعم',
      groupId: group.id,
      groupName: group.name
    });
  } catch (error) {
    console.error('Send problem to group error:', error);
    res.status(500).json({ success: false, error: 'فشل في إرسال المشكلة إلى مجموعة الدعم' });
  }
});

// Check WhatsApp connection status
router.get('/whatsapp-status', authenticateToken, async (req, res) => {
  try {
    const sock = global.whatsappSocket;
    const isConnected = sock && !!sock.user;
    
    res.json({ 
      success: true, 
      connected: isConnected,
      socketExists: !!sock,
      status: isConnected ? 'متصل' : 'غير متصل',
      message: isConnected ? 'WhatsApp جاهز لإرسال الرسائل' : 'WhatsApp غير متصل حالياً'
    });
  } catch (error) {
    console.error('WhatsApp status check error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'فشل في فحص حالة WhatsApp' 
    });
  }
});

// List all WhatsApp groups the bot is in
router.get('/list-groups', authenticateToken, async (req, res) => {
  try {
    const sock = global.whatsappSocket;
    if (!sock || !sock.user) {
      return res.status(503).json({ 
        success: false, 
        error: 'WhatsApp غير متصل حالياً' 
      });
    }

    console.log('[DEBUG] Bot user ID:', sock.user.id);
    
    // Method 1: Try to get chats list
    try {
      // Use the chat store to get all chats
      const store = sock.chats;
      if (store) {
        const allChats = store;
        const groups = allChats
          .filter(chat => chat.id.includes('@g.us'))
          .map(chat => ({
            jid: chat.id,
            name: chat.name || chat.id,
            unreadCount: chat.unreadCount || 0
          }));
        
        console.log(`[DEBUG] Found ${groups.length} groups in chat store:`, groups);
        
        if (groups.length > 0) {
          return res.json({
            success: true,
            method: 'chat_store',
            groups: groups,
            message: `تم العثور على ${groups.length} مجموعة`
          });
        }
      }
    } catch (error) {
      console.log('[DEBUG] Chat store method failed:', error.message);
    }
    
    // Method 2: Test common formats with your phone number
    const baseNumber = '201128511900'; // Egypt country code + your number
    const testFormats = [
      `${baseNumber}@g.us`,
      `${baseNumber}-${baseNumber}@g.us`,
      `1128511900@g.us`,
      `1128511900-1128511900@g.us`,
    ];
    
    console.log('[DEBUG] Testing group JID formats...');
    const foundGroups = [];
    
    for (const jid of testFormats) {
      try {
        const metadata = await sock.groupMetadata(jid);
        foundGroups.push({
          jid: jid,
          subject: metadata.subject,
          desc: metadata.desc,
          valid: true
        });
        console.log(`[SUCCESS] Found group: ${jid} - ${metadata.subject}`);
      } catch (error) {
        console.log(`[FAILED] ${jid}: ${error.message}`);
      }
    }

    res.json({ 
      success: true, 
      method: 'test_formats',
      testedFormats: testFormats,
      foundGroups: foundGroups,
      botUserId: sock.user.id,
      instructions: [
        'إذا لم يتم العثور على مجموعات:',
        '1. تأكد من أن البوت عضو في المجموعة',
        '2. أضف رقم البوت إلى المجموعة يدوياً',
        '3. جرب الأرقام الموجودة أعلاه',
        '4. استخدم WhatsApp Web للحصول على المعرف الصحيح'
      ]
    });
  } catch (error) {
    console.error('List groups error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'فشل في جلب قائمة المجموعات' 
    });
  }
});

module.exports = router;
