const logger = require('../services/loggerService');

class AppError extends Error {
  constructor(message, statusCode, isOperational = true) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.status = `${statusCode}`.startsWith('4') ? 'fail' : 'error';

    Error.captureStackTrace(this, this.constructor);
  }
}

const errorHandler = (err, req, res, next) => {
  let error = { ...err };
  error.message = err.message;

  // Log error
  logger.error('Error occurred', err, {
    url: req.url,
    method: req.method,
    ip: req.ip,
    userAgent: req.get('User-Agent')
  });

  // Prisma error
  if (err.code === 'P2002') {
    error = new AppError('Duplicate entry', 400);
  }

  // JWT error
  if (err.name === 'JsonWebTokenError') {
    error = new AppError('Invalid token', 401);
  }

  // Validation error
  if (err.name === 'ValidationError') {
    error = new AppError(err.message, 400);
  }

  // Cast error
  if (err.name === 'CastError') {
    error = new AppError('Invalid resource', 400);
  }

  res.status(error.statusCode || 500).json({
    status: error.status || 'error',
    message: error.message,
    ...(process.env.NODE_ENV === 'development' && { stack: error.stack })
  });
};

module.exports = {
  AppError,
  errorHandler
};
