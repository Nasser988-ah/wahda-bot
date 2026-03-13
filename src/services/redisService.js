/**
 * Redis/Upstash Service
 * Wrapper around Upstash Redis client with fallback handling
 */

const { Redis } = require("@upstash/redis");

class RedisService {
  constructor() {
    this.redis = null;
    this.isConnected = false;
    this.failureCount = 0;
    this.maxFailures = 5;
    this.init();
  }

  init() {
    try {
      const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
      const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

      if (!redisUrl || !redisToken) {
        console.warn('⚠️  Redis configuration incomplete. Caching features will be disabled.');
        console.warn('   Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN to enable caching.');
        this.isConnected = false;
        return;
      }

      this.redis = new Redis({
        url: redisUrl,
        token: redisToken,
      });

      // Test connection
      this.testConnection();
    } catch (error) {
      console.error('❌ Redis initialization failed:', error.message);
      this.isConnected = false;
    }
  }

  async testConnection() {
    try {
      if (!this.redis) {
        this.isConnected = false;
        return;
      }

      await this.redis.ping();
      this.isConnected = true;
      this.failureCount = 0;
      console.log('✅ Redis connected successfully');
    } catch (error) {
      console.warn('⚠️  Redis connection test failed:', error.message);
      this.isConnected = false;
    }
  }

  /**
   * Get value from Redis with fallback
   */
  async get(key) {
    if (!this.isConnected || !this.redis) {
      return null;
    }

    try {
      return await this.redis.get(key);
    } catch (error) {
      this.failureCount++;
      if (this.failureCount >= this.maxFailures) {
        console.warn('⚠️  Redis failing consistently, disabling cache');
        this.isConnected = false;
      }
      return null;
    }
  }

  /**
   * Set value in Redis with fallback
   */
  async set(key, value, options = {}) {
    if (!this.isConnected || !this.redis) {
      return null;
    }

    try {
      return await this.redis.set(key, value, options);
    } catch (error) {
      this.failureCount++;
      if (this.failureCount >= this.maxFailures) {
        console.warn('⚠️  Redis failing consistently, disabling cache');
        this.isConnected = false;
      }
      return null;
    }
  }

  /**
   * Delete key from Redis with fallback
   */
  async del(key) {
    if (!this.isConnected || !this.redis) {
      return 0;
    }

    try {
      return await this.redis.del(key);
    } catch (error) {
      this.failureCount++;
      if (this.failureCount >= this.maxFailures) {
        console.warn('⚠️  Redis failing consistently, disabling cache');
        this.isConnected = false;
      }
      return 0;
    }
  }

  /**
   * Execute Redis command with fallback
   */
  async execute(command, ...args) {
    if (!this.isConnected || !this.redis) {
      return null;
    }

    try {
      return await this.redis[command](...args);
    } catch (error) {
      this.failureCount++;
      if (this.failureCount >= this.maxFailures) {
        console.warn('⚠️  Redis failing consistently, disabling cache');
        this.isConnected = false;
      }
      return null;
    }
  }

  /**
   * Check if Redis is available
   */
  isAvailable() {
    return this.isConnected && this.redis != null;
  }

  /**
   * Get health status
   */
  async healthCheck() {
    if (!this.redis) {
      return { status: 'unavailable', reason: 'Not configured' };
    }

    try {
      await this.redis.ping();
      return { status: 'healthy', connected: true };
    } catch (error) {
      return { status: 'unhealthy', error: error.message, connected: false };
    }
  }
}

// Singleton instance
const redisService = new RedisService();

module.exports = redisService;
