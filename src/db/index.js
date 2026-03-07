const databaseService = require("../services/databaseService");

// Export the singleton database client
module.exports = databaseService.getClient();
