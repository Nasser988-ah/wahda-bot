const express = require("express");
const bcrypt = require("bcryptjs");
const { z } = require("zod");
const { authenticateAdmin, verifyAdminCredentials, generateAdminToken, ADMIN_USERNAME } = require("../middleware/admin.middleware");
const databaseService = require("../../services/databaseService");
const QRService = require("../../services/qrService");

const router = express.Router();

// Helper function to get Prisma client
function getPrisma() {
  if (!databaseService.isConnected) {
    throw new Error('Database is not configured');
  }
  return databaseService.getClient();
}

// Validation schema for admin login
const adminLoginSchema = z.object({
  username: z.string().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
});

// Admin login
router.post("/login", async (req, res) => {
  try {
    const validation = adminLoginSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({
        error: "Validation failed",
        details: validation.error.errors
      });
    }

    const { username, password } = validation.data;

    // Verify credentials
    const isValid = await verifyAdminCredentials(username, password);
    if (!isValid) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // Generate token
    const token = generateAdminToken();

    res.json({
      message: "Admin login successful",
      token,
      admin: {
        username: ADMIN_USERNAME,
        role: 'super_admin'
      }
    });

  } catch (error) {
    console.error("Admin login error:", error);
    res.status(500).json({ error: "Login failed" });
  }
});

// Get platform statistics
router.get("/stats", authenticateAdmin, async (req, res) => {
  try {
    const prisma = getPrisma();

    const [
      totalShops,
      activeShops,
      trialShops,
      expiredShops,
      totalProducts,
      totalOrders,
      recentOrders,
      revenueStats
    ] = await Promise.all([
      prisma.shop.count(),
      prisma.shop.count({ where: { subscriptionStatus: "ACTIVE" } }),
      prisma.shop.count({ where: { subscriptionStatus: "TRIAL" } }),
      prisma.shop.count({ where: { subscriptionStatus: "EXPIRED" } }),
      prisma.product.count(),
      prisma.order.count(),
      prisma.order.count({
        where: {
          createdAt: {
            gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) // Last 7 days
          }
        }
      }),
      prisma.order.aggregate({
        where: { status: "DELIVERED" },
        _sum: { totalPrice: true }
      })
    ]);

    res.json({
      shops: {
        total: totalShops,
        active: activeShops,
        trial: trialShops,
        expired: expiredShops
      },
      products: totalProducts,
      orders: {
        total: totalOrders,
        recent: recentOrders
      },
      revenue: revenueStats._sum.totalPrice || 0
    });

  } catch (error) {
    console.error("Get admin stats error:", error);
    res.status(500).json({ error: "Failed to get statistics" });
  }
});

// Get all shops with details
router.get("/shops", authenticateAdmin, async (req, res) => {
  try {
    const prisma = getPrisma();
    const { page = 1, limit = 20, status, search } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const where = {
      ...(status && { subscriptionStatus: status }),
      ...(search && {
        OR: [
          { name: { contains: search, mode: "insensitive" } },
          { ownerName: { contains: search, mode: "insensitive" } },
          { phone: { contains: search } },
          { whatsappNumber: { contains: search } }
        ]
      })
    };

    const [shops, total] = await Promise.all([
      prisma.shop.findMany({
        where,
        skip,
        take: parseInt(limit),
        orderBy: { createdAt: "desc" },
        include: {
          _count: {
            select: {
              products: true,
              orders: true
            }
          }
        }
      }),
      prisma.shop.count({ where })
    ]);

    res.json({
      shops,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });

  } catch (error) {
    console.error("Get shops error:", error);
    res.status(500).json({ error: "Failed to get shops" });
  }
});

// Get single shop details
router.get("/shops/:id", authenticateAdmin, async (req, res) => {
  try {
    const prisma = getPrisma();
    const { id } = req.params;

    const shop = await prisma.shop.findUnique({
      where: { id },
      include: {
        products: {
          orderBy: { createdAt: "desc" },
          take: 10
        },
        orders: {
          orderBy: { createdAt: "desc" },
          take: 10,
          include: {
            orderItems: {
              include: {
                product: {
                  select: { name: true, price: true }
                }
              }
            }
          }
        },
        _count: {
          select: {
            products: true,
            orders: true,
            messages: true
          }
        }
      }
    });

    if (!shop) {
      return res.status(404).json({ error: "Shop not found" });
    }

    // Get WhatsApp connection status
    const qrService = new QRService();
    const connectionStatus = await qrService.getConnectionStatus(id);

    res.json({
      ...shop,
      whatsappStatus: connectionStatus
    });

  } catch (error) {
    console.error("Get shop details error:", error);
    res.status(500).json({ error: "Failed to get shop details" });
  }
});

// Update shop subscription status
router.put("/shops/:id/subscription", authenticateAdmin, async (req, res) => {
  try {
    const prisma = getPrisma();
    const { id } = req.params;
    const { status, subscriptionEnd } = req.body;

    const updateData = {};
    if (status) updateData.subscriptionStatus = status;
    if (subscriptionEnd) updateData.subscriptionEnd = new Date(subscriptionEnd);

    const shop = await prisma.shop.update({
      where: { id },
      data: updateData,
      select: {
        id: true,
        name: true,
        subscriptionStatus: true,
        subscriptionEnd: true
      }
    });

    res.json({
      message: "Shop subscription updated successfully",
      shop
    });

  } catch (error) {
    console.error("Update subscription error:", error);
    res.status(500).json({ error: "Failed to update subscription" });
  }
});

// Delete shop
router.delete("/shops/:id", authenticateAdmin, async (req, res) => {
  try {
    const prisma = getPrisma();
    const { id } = req.params;

    // Disconnect WhatsApp if connected
    try {
      const qrService = new QRService();
      await qrService.disconnectShop(id);
    } catch (err) {
      console.log("Disconnect warning:", err.message);
    }

    // Delete shop (cascade will handle related records)
    await prisma.shop.delete({
      where: { id }
    });

    res.json({ message: "Shop deleted successfully" });

  } catch (error) {
    console.error("Delete shop error:", error);
    res.status(500).json({ error: "Failed to delete shop" });
  }
});

// Get all orders
router.get("/orders", authenticateAdmin, async (req, res) => {
  try {
    const prisma = getPrisma();
    const { page = 1, limit = 20, status, shopId } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const where = {
      ...(status && { status }),
      ...(shopId && { shopId })
    };

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where,
        skip,
        take: parseInt(limit),
        orderBy: { createdAt: "desc" },
        include: {
          shop: {
            select: { name: true, phone: true }
          },
          orderItems: {
            include: {
              product: {
                select: { name: true, price: true }
              }
            }
          }
        }
      }),
      prisma.order.count({ where })
    ]);

    res.json({
      orders,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });

  } catch (error) {
    console.error("Get orders error:", error);
    res.status(500).json({ error: "Failed to get orders" });
  }
});

// Get recent activity
router.get("/activity", authenticateAdmin, async (req, res) => {
  try {
    const prisma = getPrisma();

    const recentShops = await prisma.shop.findMany({
      take: 10,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        ownerName: true,
        createdAt: true,
        subscriptionStatus: true
      }
    });

    const recentOrders = await prisma.order.findMany({
      take: 10,
      orderBy: { createdAt: "desc" },
      include: {
        shop: {
          select: { name: true }
        }
      }
    });

    res.json({
      recentShops,
      recentOrders
    });

  } catch (error) {
    console.error("Get activity error:", error);
    res.status(500).json({ error: "Failed to get activity" });
  }
});

// Send announcement to all shops
router.post("/announcements", authenticateAdmin, async (req, res) => {
  try {
    const { message, type = "info" } = req.body;

    if (!message || message.trim().length === 0) {
      return res.status(400).json({ error: "Message is required" });
    }

    // Store announcement in database (if you add an Announcement model)
    // For now, just log it
    console.log(`📢 Announcement from admin (${type}): ${message}`);

    res.json({
      message: "Announcement sent successfully",
      announcement: { message, type, sentAt: new Date() }
    });

  } catch (error) {
    console.error("Send announcement error:", error);
    res.status(500).json({ error: "Failed to send announcement" });
  }
});

// Get system health
router.get("/health", authenticateAdmin, async (req, res) => {
  try {
    const dbStatus = databaseService.isConnected ? 'connected' : 'disconnected';
    const memoryUsage = process.memoryUsage();
    const uptime = process.uptime();

    res.json({
      status: 'healthy',
      database: dbStatus,
      uptime: Math.floor(uptime),
      memory: {
        used: Math.round(memoryUsage.heapUsed / 1024 / 1024) + ' MB',
        total: Math.round(memoryUsage.heapTotal / 1024 / 1024) + ' MB'
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error("Health check error:", error);
    res.status(500).json({ error: "Health check failed" });
  }
});

module.exports = router;
