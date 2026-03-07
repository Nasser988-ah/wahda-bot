const jwt = require("jsonwebtoken");
const prisma = require("../../db/index");

const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(" ")[1];

    if (!token) {
      return res.status(401).json({ error: "Access token required" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
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

module.exports = { authenticateToken };
