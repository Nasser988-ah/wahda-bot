const express = require("express");
const prisma = require("../../db/index");
const { authenticateToken, authenticateTokenWithPending } = require("../middleware/auth.middleware");
const { z } = require("zod");
const qrService = require("../../services/qrService");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { uploadImage, isStorageConfigured } = require("../../services/storageService");
const router = express.Router();

// Configure multer for temp storage
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const tmpDir = 'tmp/';
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
    cb(null, tmpDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 2 * 1024 * 1024 // 2MB limit
  },
  fileFilter: function (req, file, cb) {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPEG, PNG and WebP are allowed.'));
    }
  }
});

// Get botManager instance from qrService singleton
const botManager = qrService.botManager;

// QR routes - require auth to prevent unauthorized access
router.get("/qr", authenticateTokenWithPending, async (req, res) => {
  try {
    const shopId = req.query.shopId;
    
    if (!shopId) {
      return res.status(400).json({ 
        error: "Shop ID is required",
        message: "Please provide shopId as query parameter"
      });
    }

    const status = await qrService.getConnectionStatus(shopId);
    
    // Prevent caching to ensure fresh status updates
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    
    res.json({
      ...status,
      message: status.connected ? "WhatsApp is connected" : "QR code generation available"
    });

  } catch (error) {
    console.error("Get QR status error:", error);
    res.status(500).json({ error: "Failed to check connection status" });
  }
});

router.post("/qr", authenticateTokenWithPending, async (req, res) => {
  try {
    const { shopId } = req.body;
    
    if (!shopId) {
      return res.status(400).json({ 
        error: "Shop ID is required",
        message: "Please provide shopId in request body"
      });
    }

    console.log(`🔄 Generating QR for shop: ${shopId}`);
    
    // Check if already connected
    const status = await qrService.getConnectionStatus(shopId);
    if (status.connected) {
      return res.json({
        connected: true,
        status: 'already_connected',
        shopId,
        message: "WhatsApp is already connected"
      });
    }
    
    // Check if connection is already in progress
    // But if stuck for more than 30 seconds, allow reset
    if (status.status === 'connecting') {
      console.log(`⚠️ Connection stuck in connecting state for ${shopId}, resetting...`);
      // Reset the connection state to allow new QR generation
      qrService.botManager.connectionStates.set(shopId, 'not_started');
    }
    
    // Check if QR already exists and not expired - don't regenerate
    if (status.qrGenerated && status.status !== 'expired' && status.status !== 'not_started') {
      console.log(`ℹ️ QR already exists for ${shopId}, returning existing QR`);
      return res.json({
        ...status,
        message: "QR code already available - scan with WhatsApp"
      });
    }
    
    // Only generate new QR if needed
    const qrResult = await qrService.generateQR(shopId, false); // Don't force
    
    console.log(`✅ QR generated for shop: ${shopId}`);
    
    res.json({
      ...qrResult,
      message: "QR code generated successfully",
      instructions: "Scan this QR code with WhatsApp to connect"
    });

  } catch (error) {
    console.error("Generate QR error:", error);
    res.status(500).json({
      connected: false,
      status: 'error',
      message: "فشل إنشاء كود QR، يرجى المحاولة مرة أخرى"
    });
  }
});


router.post("/qr/refresh", authenticateTokenWithPending, async (req, res) => {
  try {
    const shopId = req.query.shopId || req.body.shopId;
    
    if (!shopId) {
      return res.status(400).json({ 
        error: "Shop ID is required",
        message: "Please provide shopId as query parameter or in request body"
      });
    }

    console.log(`🔄 QR Refresh requested for shop: ${shopId}`);
    
    // Disconnect existing connection
    await botManager.disconnectShop(shopId);
    console.log(`🔌 Disconnected shop ${shopId}`);
    
    // Clear current QR
    botManager.clearCurrentQr(shopId);
    botManager.qrReceived.set(shopId, false);
    
    // Reset connection state
    botManager.connectionStates.set(shopId, 'not_started');
    
    // Wait a moment for cleanup
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Start fresh connection
    botManager.connectShop(shopId, (qr) => {
      botManager.setCurrentQr(shopId, qr);
    });
    
    res.json({ 
      success: true, 
      message: 'جارٍ إنشاء رمز QR جديد',
      shopId: shopId
    });
    
  } catch (err) {
    console.error('QR Refresh error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get current shop (allows pending payment accounts) - MUST be before auth middleware
router.get("/me", authenticateTokenWithPending, async (req, res) => {
  try {
    const shopId = req.shop.id;

    const shop = await prisma.shop.findUnique({
      where: { id: shopId },
      select: {
        id: true,
        name: true,
        ownerName: true,
        phone: true,
        whatsappNumber: true,
        subscriptionStatus: true,
        subscriptionEnd: true,
        createdAt: true,
        updatedAt: true,
        _count: {
          select: {
            products: true,
            orders: true
          }
        }
      }
    });

    if (!shop) {
      return res.status(404).json({ error: "Shop not found" });
    }

    res.json(shop);

  } catch (error) {
    console.error("Get shop error:", error);
    res.status(500).json({ error: "Failed to get shop details" });
  }
});

// Apply auth middleware to remaining routes
router.use(authenticateToken);

// Validation schemas
const updateShopSchema = z.object({
  name: z.string().min(2, "Shop name must be at least 2 characters").optional(),
  ownerName: z.string().min(2, "Owner name must be at least 2 characters").optional(),
  whatsappNumber: z.string().regex(/^20\d{10}$/, "WhatsApp number must be Egyptian number starting with 20").optional(),
  phone: z.string().regex(/^20\d{10}$/, "Phone number must be Egyptian number starting with 20").optional(),
});

// Update shop info
router.put("/me", async (req, res) => {
  try {
    const validation = updateShopSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ 
        error: "Validation failed", 
        details: validation.error.errors 
      });
    }

    const updateData = validation.data;

    // Check if whatsappNumber is being updated and if it's already used
    if (updateData.whatsappNumber) {
      const existingShop = await prisma.shop.findFirst({
        where: {
          whatsappNumber: updateData.whatsappNumber,
          id: { not: req.shop.id }
        }
      });

      if (existingShop) {
        return res.status(400).json({ error: "WhatsApp number already used by another shop" });
      }
    }

    const shop = await prisma.shop.update({
      where: { id: req.shop.id },
      data: updateData,
      select: {
        id: true,
        name: true,
        ownerName: true,
        phone: true,
        whatsappNumber: true,
        subscriptionStatus: true,
        subscriptionEnd: true,
        createdAt: true,
        updatedAt: true
      }
    });

    res.json({
      message: "Shop updated successfully",
      shop
    });

  } catch (error) {
    console.error("Update shop error:", error);
    res.status(500).json({ error: "Failed to update shop" });
  }
});


// Get shop statistics
router.get("/stats", async (req, res) => {
  try {
    const stats = await prisma.shop.findUnique({
      where: { id: req.shop.id },
      select: {
        _count: {
          select: {
            products: {
              where: { isAvailable: true }
            },
            orders: {
              where: {
                createdAt: {
                  gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // Last 30 days
                }
              }
            }
          }
        }
      }
    });

    // Get recent orders
    const recentOrders = await prisma.order.findMany({
      where: { shopId: req.shop.id },
      take: 5,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        customerPhone: true,
        customerName: true,
        status: true,
        totalPrice: true,
        createdAt: true
      }
    });

    res.json({
      products: stats?._count?.products || 0,
      recentOrders: stats?._count?.orders || 0,
      recentOrdersList: recentOrders
    });

  } catch (error) {
    console.error("Get stats error:", error);
    res.status(500).json({ error: "Failed to get shop statistics" });
  }
});

// Upload image for variants
router.post('/upload-image', authenticateToken, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'لم يتم رفع أي صورة' });
    }

    if (!isStorageConfigured()) {
      return res.status(500).json({ error: 'Cloudinary not configured' });
    }

    // Upload to Cloudinary
    const timestamp = Date.now();
    const publicId = `wahda-products/variant-${req.shop.id}-${timestamp}`;
    const imageUrl = await uploadImage(req.file.path, publicId);

    // Clean up temp file
    if (fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    res.json({ success: true, imageUrl });
  } catch (err) {
    console.error('Variant image upload error:', err);
    // Clean up temp file on error
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ error: err.message });
  }
});

// Get store customization settings
router.get('/customization', authenticateToken, async (req, res) => {
  try {
    const shop = await prisma.shop.findUnique({
      where: { id: req.shop.id },
      select: {
        logoUrl: true,
        primaryColor: true,
        secondaryColor: true,
        backgroundColor: true,
        textColor: true,
        accentColor: true,
        fontFamily: true
      }
    });

    if (!shop) {
      return res.status(404).json({ error: 'المتجر غير موجود' });
    }

    res.json({
      logoUrl: shop.logoUrl,
      primaryColor: shop.primaryColor || '#f5c842',
      secondaryColor: shop.secondaryColor || '#1a1a22',
      backgroundColor: shop.backgroundColor || '#0f0f13',
      textColor: shop.textColor || '#ffffff',
      accentColor: shop.accentColor || '#fde98a',
      fontFamily: shop.fontFamily || 'Cairo'
    });
  } catch (error) {
    console.error('Get customization error:', error);
    res.status(500).json({ error: 'فشل في تحميل الإعدادات' });
  }
});

// Update store customization settings
router.put('/customization', authenticateToken, async (req, res) => {
  try {
    const {
      logoUrl,
      primaryColor,
      secondaryColor,
      backgroundColor,
      textColor,
      accentColor,
      fontFamily
    } = req.body;

    const updatedShop = await prisma.shop.update({
      where: { id: req.shop.id },
      data: {
        logoUrl,
        primaryColor,
        secondaryColor,
        backgroundColor,
        textColor,
        accentColor,
        fontFamily
      },
      select: {
        logoUrl: true,
        primaryColor: true,
        secondaryColor: true,
        backgroundColor: true,
        textColor: true,
        accentColor: true,
        fontFamily: true
      }
    });

    res.json({
      message: 'تم تحديث الإعدادات بنجاح',
      customization: updatedShop
    });
  } catch (error) {
    console.error('Update customization error:', error);
    res.status(500).json({ error: 'فشل في تحديث الإعدادات' });
  }
});

// Upload store logo
router.post('/logo', authenticateToken, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'لم يتم رفع أي صورة' });
    }

    if (!isStorageConfigured()) {
      return res.status(500).json({ error: 'Cloudinary not configured' });
    }

    // Upload to Cloudinary
    const timestamp = Date.now();
    const publicId = `wahda-shops/logo-${req.shop.id}-${timestamp}`;
    const imageUrl = await uploadImage(req.file.path, publicId);

    // Clean up temp file
    if (fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    // Update shop with new logo URL
    await prisma.shop.update({
      where: { id: req.shop.id },
      data: { logoUrl: imageUrl }
    });

    res.json({ success: true, imageUrl });
  } catch (err) {
    console.error('Logo upload error:', err);
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
