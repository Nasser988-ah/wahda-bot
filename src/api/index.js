const express = require("express");
const router = express.Router();

// Import routes
const authRoutes = require("./routes/auth.routes");
const shopRoutes = require("./routes/shop.routes");
const productRoutes = require("./routes/product.routes");
const orderRoutes = require("./routes/order.routes");

// Mount routes
router.use("/auth", authRoutes);
router.use("/shop", shopRoutes);
router.use("/products", productRoutes);
router.use("/orders", orderRoutes);

module.exports = router;
