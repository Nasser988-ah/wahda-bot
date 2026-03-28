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

module.exports = router;
