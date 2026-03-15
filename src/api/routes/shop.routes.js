const express = require("express");
const prisma = require("../../db/index");
const { authenticateToken, authenticateTokenWithPending } = require("../middleware/auth.middleware");
const { z } = require("zod");
const qrService = require("../../services/qrService");
const router = express.Router();

// Get botManager instance from qrService singleton
const botManager = qrService.botManager;

// QR routes (no auth required for initial connection)
router.get("/qr", async (req, res) => {
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

router.post("/qr", async (req, res) => {
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
    
    // Provide fallback QR for demo purposes
    const fallbackQR = await require('qrcode').toDataURL(`WA-BOT-${Date.now()}`, {
      width: 200,
      margin: 2
    });
    
    res.json({
      qr: fallbackQR.split(',')[1],
      shopId: req.body.shopId || "demo",
      connected: false,
      status: 'demo_mode',
      message: "QR code generated (demo mode)",
      error: error.message,
      note: "Real WhatsApp connection requires BotManager integration"
    });
  }
});


router.post("/qr/refresh", async (req, res) => {
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

module.exports = router;
