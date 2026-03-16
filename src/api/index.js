const express = require("express");
const router = express.Router();
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

// Import middleware
const { requireDatabase } = require("./middleware/database.middleware");

// Import routes
const authRoutes = require("./routes/auth.routes");
const shopRoutes = require("./routes/shop.routes");
const productRoutes = require("./routes/product.routes");
const orderRoutes = require("./routes/order.routes");
const adminRoutes = require("./routes/admin.routes");

// PUBLIC STORE API - No authentication required
// This must be before auth middleware
router.get("/store/:shopId", async (req, res) => {
  try {
    const shop = await prisma.shop.findUnique({
      where: { id: req.params.shopId },
      select: {
        id: true,
        name: true,
        whatsappNumber: true,
        logoUrl: true,
        primaryColor: true,
        secondaryColor: true,
        backgroundColor: true,
        textColor: true,
        accentColor: true,
        fontFamily: true,
        products: {
          where: { isAvailable: true },
          select: {
            id: true,
            name: true,
            price: true,
            description: true,
            imageUrl: true,
            category: true,
            isAvailable: true,
            stock: true,
            variants: true,
            variantImages: true
          }
        }
      }
    });

    if (!shop) {
      return res.status(404).json({ error: "المتجر غير موجود" });
    }

    res.json(shop);
  } catch (err) {
    console.error("Get store error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Mount routes
// Auth routes handle their own database checks
router.use("/auth", authRoutes);

// Admin routes (protected by admin middleware)
router.use("/admin", requireDatabase, adminRoutes);

// Shop, products, and orders require database
router.use("/shop", requireDatabase, shopRoutes);
router.use("/products", requireDatabase, productRoutes);
router.use("/orders", requireDatabase, orderRoutes);

module.exports = router;
