const databaseService = require("../services/databaseService");

// Export the database service so routes can check connection status
// Routes should call getPrisma() helper instead of using this directly
module.exports = databaseService.getClient() || null;
module.exports.databaseService = databaseService;
module.exports.isConnected = () => databaseService.isConnected;
