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

    // Here you would integrate with WhatsApp to send to the group
    // For now, we'll just log it (you can implement the actual WhatsApp sending later)
    console.log('Sending to support group:', group.groupNumber);
    console.log('Message:', problemMessage);

    // TODO: Implement actual WhatsApp group message sending
    // const botManager = require('../bot/botManager');
    // await botManager.sendMessageToGroup(group.groupNumber, problemMessage);

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

module.exports = router;
