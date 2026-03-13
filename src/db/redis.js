/**
 * Redis client export
 * Re-exports the Redis service for backward compatibility
 */

const redisService = require("../services/redisService");

// Export the service directly, maintaining backward compatibility
module.exports = redisService;
