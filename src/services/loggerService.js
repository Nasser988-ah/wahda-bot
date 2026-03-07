const pino = require('pino');

class LoggerService {
  constructor() {
    this.logger = pino({
      level: process.env.LOG_LEVEL || 'info',
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss Z',
          ignore: 'pid,hostname'
        }
      }
    });
  }

  info(message, meta = {}) {
    this.logger.info(message, meta);
  }

  warn(message, meta = {}) {
    this.logger.warn(message, meta);
  }

  error(message, error = null, meta = {}) {
    if (error) {
      meta.error = error.message;
      meta.stack = error.stack;
    }
    this.logger.error(message, meta);
  }

  debug(message, meta = {}) {
    this.logger.debug(message, meta);
  }

  child(bindings) {
    return this.logger.child(bindings);
  }
}

// Singleton instance
const logger = new LoggerService();

module.exports = logger;
