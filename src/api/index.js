const express = require("express");
const router = express.Router();

// Import middleware
const { requireDatabase } = require("./middleware/database.middleware");

// Import routes
const authRoutes = require("./routes/auth.routes");
const shopRoutes = require("./routes/shop.routes");
const productRoutes = require("./routes/product.routes");
const orderRoutes = require("./routes/order.routes");

// Mount routes
// Auth routes handle their own database checks
router.use("/auth", authRoutes);

// Shop, products, and orders require database
router.use("/shop", requireDatabase, shopRoutes);
router.use("/products", requireDatabase, productRoutes);
router.use("/orders", requireDatabase, orderRoutes);

module.exports = router;
