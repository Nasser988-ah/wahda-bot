const jwt = require("jsonwebtoken");
const databaseService = require("../../services/databaseService");

const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(" ")[1];

    if (!token) {
      return res.status(401).json({ error: "Access token required" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Check database is connected
    if (!databaseService.isConnected) {
      return res.status(503).json({ 
        error: "Service Unavailable", 
        message: "Database is not available. Please try again later." 
      });
    }

    const prisma = databaseService.getClient();
    if (!prisma) {
      return res.status(503).json({ 
        error: "Service Unavailable", 
        message: "Database connection failed." 
      });
    }

    // Get shop from database
    const shop = await prisma.shop.findUnique({
      where: { id: decoded.shopId },
      select: {
        id: true,
        name: true,
        ownerName: true,
        phone: true,
        whatsappNumber: true,
        subscriptionStatus: true,
        subscriptionEnd: true,
        createdAt: true
      }
    });

    if (!shop) {
      return res.status(401).json({ error: "Shop not found" });
    }

    // Check subscription status
    if (shop.subscriptionStatus === "PENDING_PAYMENT") {
      return res.status(402).json({ 
        error: "Payment required",
        paymentRequired: true,
        message: "Your account is pending payment approval. Please complete payment to access dashboard."
      });
    }

    if (shop.subscriptionStatus === "EXPIRED") {
      return res.status(403).json({ error: "Subscription expired" });
    }

    if (shop.subscriptionStatus === "TRIAL" && shop.subscriptionEnd && shop.subscriptionEnd < new Date()) {
      return res.status(403).json({ error: "Trial period expired" });
    }

    req.shop = shop;
    next();
  } catch (error) {
    if (error.name === "JsonWebTokenError") {
      return res.status(401).json({ error: "Invalid token" });
    }
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Token expired" });
    }
    console.error("Auth middleware error:", error);
    return res.status(500).json({ error: "Authentication error" });
  }
};

// Middleware that allows pending payment accounts (for payment page)
const authenticateTokenWithPending = async (req, res, next) => {
  try {
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(" ")[1];

    if (!token) {
      return res.status(401).json({ error: "Access token required" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Check database is connected
    if (!databaseService.isConnected) {
      return res.status(503).json({ 
        error: "Service Unavailable", 
        message: "Database is not available. Please try again later." 
      });
    }

    const prisma = databaseService.getClient();
    if (!prisma) {
      return res.status(503).json({ 
        error: "Service Unavailable", 
        message: "Database connection failed." 
      });
    }

    // Get shop from database
    const shop = await prisma.shop.findUnique({
      where: { id: decoded.shopId },
      select: {
        id: true,
        name: true,
        ownerName: true,
        phone: true,
        whatsappNumber: true,
        subscriptionStatus: true,
        subscriptionEnd: true,
        createdAt: true
      }
    });

    if (!shop) {
      return res.status(401).json({ error: "Shop not found" });
    }

    // Only block expired accounts, not pending ones
    if (shop.subscriptionStatus === "EXPIRED") {
      return res.status(403).json({ error: "Subscription expired" });
    }

    if (shop.subscriptionStatus === "TRIAL" && shop.subscriptionEnd && shop.subscriptionEnd < new Date()) {
      return res.status(403).json({ error: "Trial period expired" });
    }

    req.shop = shop;
    next();
  } catch (error) {
    if (error.name === "JsonWebTokenError") {
      return res.status(401).json({ error: "Invalid token" });
    }
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Token expired" });
    }
    console.error("Auth middleware error:", error);
    return res.status(500).json({ error: "Authentication error" });
  }
};

module.exports = { authenticateToken, authenticateTokenWithPending };
