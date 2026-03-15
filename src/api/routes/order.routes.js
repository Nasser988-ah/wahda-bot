const express = require("express");
const prisma = require("../../db/index");
const { authenticateToken } = require("../middleware/auth.middleware");
const { z } = require("zod");
const router = express.Router();

// Apply auth middleware to all routes
router.use(authenticateToken);

// Validation schemas
const updateOrderStatusSchema = z.object({
  status: z.enum(["PENDING", "CONFIRMED", "CANCELLED", "DELIVERED"]),
});

// Get all orders for the shop
router.get("/", async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 20, 
      status, 
      startDate, 
      endDate,
      search 
    } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Build where clause
    const where = {
      shopId: req.shop.id,
      ...(status && { status }),
      ...(startDate && endDate && {
        createdAt: {
          gte: new Date(startDate),
          lte: new Date(endDate)
        }
      }),
      ...(search && {
        OR: [
          { customerPhone: { contains: search, mode: "insensitive" } },
          { customerName: { contains: search, mode: "insensitive" } }
        ]
      })
    };

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where,
        skip,
        take: parseInt(limit),
        orderBy: { createdAt: "desc" },
        include: {
          orderItems: {
            select: {
              id: true,
              quantity: true,
              priceAtTime: true,
              product: {
                select: {
                  id: true,
                  name: true,
                  price: true
                }
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

// Get single order
router.get("/:id", async (req, res) => {
  try {
    const order = await prisma.order.findFirst({
      where: {
        id: req.params.id,
        shopId: req.shop.id
      },
      include: {
          orderItems: {
            select: {
              id: true,
              quantity: true,
              priceAtTime: true,
              product: {
                select: {
                  id: true,
                  name: true,
                  price: true,
                  description: true,
                  category: true
                }
              }
            }
          }
        }
    });

    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    res.json(order);

  } catch (error) {
    console.error("Get order error:", error);
    res.status(500).json({ error: "Failed to get order" });
  }
});

// Update order status
router.put("/:id/status", async (req, res) => {
  try {
    const validation = updateOrderStatusSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ 
        error: "Validation failed", 
        details: validation.error.errors 
      });
    }

    // Check if order exists and belongs to shop
    const existingOrder = await prisma.order.findFirst({
      where: {
        id: req.params.id,
        shopId: req.shop.id
      }
    });

    if (!existingOrder) {
      return res.status(404).json({ error: "Order not found" });
    }

    const order = await prisma.order.update({
      where: { id: req.params.id },
      data: {
        status: validation.data.status
      },
      include: {
        orderItems: {
          include: {
            product: {
              select: {
                id: true,
                name: true,
                price: true
              }
            }
          }
        }
      }
    });

    res.json({
      message: "Order status updated successfully",
      order
    });

  } catch (error) {
    console.error("Update order status error:", error);
    res.status(500).json({ error: "Failed to update order status" });
  }
});

// Get order statistics
router.get("/stats/summary", async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    const dateFilter = startDate && endDate ? {
      createdAt: {
        gte: new Date(startDate),
        lte: new Date(endDate)
      }
    } : {};

    const [
      totalOrders,
      pendingOrders,
      confirmedOrders,
      deliveredOrders,
      cancelledOrders,
      totalRevenue
    ] = await Promise.all([
      prisma.order.count({
        where: { shopId: req.shop.id, ...dateFilter }
      }),
      prisma.order.count({
        where: { shopId: req.shop.id, status: "PENDING", ...dateFilter }
      }),
      prisma.order.count({
        where: { shopId: req.shop.id, status: "CONFIRMED", ...dateFilter }
      }),
      prisma.order.count({
        where: { shopId: req.shop.id, status: "DELIVERED", ...dateFilter }
      }),
      prisma.order.count({
        where: { shopId: req.shop.id, status: "CANCELLED", ...dateFilter }
      }),
      prisma.order.aggregate({
        where: { 
          shopId: req.shop.id, 
          status: "DELIVERED",
          ...dateFilter
        },
        _sum: {
          totalPrice: true
        }
      })
    ]);

    res.json({
      totalOrders,
      pendingOrders,
      confirmedOrders,
      deliveredOrders,
      cancelledOrders,
      totalRevenue: totalRevenue._sum.totalPrice || 0
    });

  } catch (error) {
    console.error("Get order stats error:", error);
    res.status(500).json({ error: "Failed to get order statistics" });
  }
});

// Get recent orders (last 10)
router.get("/recent/list", async (req, res) => {
  try {
    const orders = await prisma.order.findMany({
      where: { shopId: req.shop.id },
      take: 10,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        customerPhone: true,
        customerName: true,
        status: true,
        totalPrice: true,
        createdAt: true,
        _count: {
          select: {
            orderItems: true
          }
        }
      }
    });

    res.json({
      orders
    });

  } catch (error) {
    console.error("Get recent orders error:", error);
    res.status(500).json({ error: "Failed to get recent orders" });
  }
});

module.exports = router;
