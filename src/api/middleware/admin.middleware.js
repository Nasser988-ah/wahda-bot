const jwt = require("jsonwebtoken");
const databaseService = require("../../services/databaseService");

// Admin credentials from environment variables
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD; // Should be bcrypt hash

/**
 * Middleware to authenticate admin requests
 */
const authenticateAdmin = async (req, res, next) => {
  try {
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(" ")[1];

    if (!token) {
      return res.status(401).json({ error: "Access token required" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Check if it's an admin token
    if (!decoded.isAdmin || decoded.role !== 'super_admin') {
      return res.status(403).json({ error: "Admin access required" });
    }

    req.admin = decoded;
    next();
  } catch (error) {
    if (error.name === "JsonWebTokenError") {
      return res.status(401).json({ error: "Invalid token" });
    }
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Token expired" });
    }
    console.error("Admin auth middleware error:", error);
    return res.status(500).json({ error: "Authentication error" });
  }
};

/**
 * Verify admin credentials (for login)
 */
const verifyAdminCredentials = async (username, password) => {
  // Check if admin password is configured
  if (!ADMIN_PASSWORD_HASH) {
    console.error("ADMIN_PASSWORD not configured in environment");
    return false;
  }

  // Verify username
  if (username !== ADMIN_USERNAME) {
    return false;
  }

  // Verify password using bcrypt
  const bcrypt = require("bcryptjs");
  return await bcrypt.compare(password, ADMIN_PASSWORD_HASH);
};

/**
 * Generate admin JWT token
 */
const generateAdminToken = () => {
  return jwt.sign(
    { 
      username: ADMIN_USERNAME, 
      isAdmin: true, 
      role: 'super_admin' 
    },
    process.env.JWT_SECRET,
    { expiresIn: "24h" } // Admin tokens last 24 hours
  );
};

module.exports = { 
  authenticateAdmin, 
  verifyAdminCredentials, 
  generateAdminToken,
  ADMIN_USERNAME 
};
