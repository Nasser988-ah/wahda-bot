/**
 * Database availability middleware
 * Checks if database is configured before allowing requests to database-dependent endpoints
 */

const databaseService = require("../services/databaseService");

function requireDatabase(req, res, next) {
  if (!databaseService.isConnected) {
    return res.status(503).json({
      error: "Service Unavailable",
      message: "Database is not configured. Please contact support.",
      details: "Set DATABASE_URL environment variable to enable this feature"
    });
  }
  next();
}

module.exports = { requireDatabase };
