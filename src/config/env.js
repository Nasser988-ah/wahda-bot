/**
 * Environment Variables Configuration
 * Validates and exports all environment variables used in the application
 */

// Required environment variables
const requiredVars = {
  DATABASE_URL: 'PostgreSQL database connection string',
  JWT_SECRET: 'JWT signing secret',
  GROQ_API_KEY: 'Groq API key for AI responses'
};

// Optional environment variables with defaults
const optionalVars = {
  NODE_ENV: { default: 'development', description: 'Application environment' },
  PORT: { default: '3000', description: 'Server port' },
  LOG_LEVEL: { default: 'info', description: 'Logging level' },
  
  // Database configuration
  DATABASE_POOL_MIN: { default: '2', description: 'Minimum database pool connections' },
  DATABASE_POOL_MAX: { default: '10', description: 'Maximum database pool connections' },
  
  // Redis/Upstash configuration
  UPSTASH_REDIS_REST_URL: { default: null, description: 'Upstash Redis REST endpoint' },
  UPSTASH_REDIS_REST_TOKEN: { default: null, description: 'Upstash Redis authentication token' },
  
  // JWT configuration
  JWT_EXPIRES_IN: { default: '7d', description: 'JWT expiration time' },
  
  // Rate limiting
  RATE_LIMIT_WINDOW_MS: { default: '900000', description: 'Rate limit window in milliseconds (15 min)' },
  RATE_LIMIT_MAX_REQUESTS: { default: '100', description: 'Max requests per window' },
  
  // Bot configuration
  BOT_NAME: { default: 'Zaki', description: 'Bot display name' },
  BOT_SESSION_DIR: { default: './sessions', description: 'Directory for bot session files' },
  BOT_MAX_RETRIES: { default: '5', description: 'Max bot connection retries' },
  BOT_CONNECT_TIMEOUT: { default: '60000', description: 'Bot connection timeout in ms' },
  
  // Security
  BCRYPT_ROUNDS: { default: '12', description: 'Bcrypt salt rounds' },
  CORS_ORIGIN: { default: 'true', description: 'CORS allowed origins' },
  
  // Health check
  HEALTH_CHECK_INTERVAL: { default: '30000', description: 'Health check interval in ms' },
  
  // Supabase (optional)
  SUPABASE_URL: { default: null, description: 'Supabase project URL' },
  SUPABASE_ANON_KEY: { default: null, description: 'Supabase anonymous key' },
  SUPABASE_SERVICE_KEY: { default: null, description: 'Supabase service role key' },
  
  // AI services (optional)
  HUGGINGFACE_TOKEN: { default: null, description: 'Hugging Face API token' }
};

/**
 * Get configuration validation status (without exiting)
 */
function getConfigStatus() {
  const missing = [];
  
  // Check required variables
  for (const [key, description] of Object.entries(requiredVars)) {
    if (!process.env[key]) {
      missing.push(key);
    }
  }
  
  return {
    isValid: missing.length === 0,
    missing: missing,
    isProduction: process.env.NODE_ENV === 'production'
  };
}

/**
 * Validate environment variables
 */
function validateEnvironment() {
  const missing = [];
  
  // Check required variables
  for (const [key, description] of Object.entries(requiredVars)) {
    if (!process.env[key]) {
      missing.push(`${key} - ${description}`);
    }
  }
  
  if (missing.length > 0) {
    console.error('❌ Missing required environment variables:\n');
    missing.forEach(m => console.error(`  • ${m}`));
    console.error('\nPlease set all required environment variables before starting the application.');
    process.exit(1);
  }
  
  console.log('✅ All required environment variables are set');
}

/**
 * Get environment configuration object
 */
function getConfig() {
  const config = {};
  
  // Add required variables
  for (const key of Object.keys(requiredVars)) {
    config[key] = process.env[key];
  }
  
  // Add optional variables with defaults
  for (const [key, { default: defaultValue }] of Object.entries(optionalVars)) {
    config[key] = process.env[key] || defaultValue;
  }
  
  return config;
}

/**
 * Log configuration status (secrets hidden)
 */
function logConfiguration() {
  const config = getConfig();
  const isProduction = config.NODE_ENV === 'production';
  
  console.log('\n📋 Application Configuration:');
  console.log(`  Environment: ${config.NODE_ENV}`);
  console.log(`  Port: ${config.PORT}`);
  console.log(`  Log Level: ${config.LOG_LEVEL}`);
  console.log(`  Database: ${config.DATABASE_URL ? '✅ Connected' : '❌ Not configured'}`);
  console.log(`  Redis: ${config.UPSTASH_REDIS_REST_URL ? '✅ Configured' : '⚠️  Optional (caching disabled)'}`);
  console.log(`  Groq AI: ${config.GROQ_API_KEY ? '✅ Configured' : '❌ Not configured'}`);
  console.log(`  Supabase: ${config.SUPABASE_URL ? '✅ Configured' : '⚠️  Optional'}`);
  console.log();
}

// Export functions and config
module.exports = {
  validateEnvironment,
  getConfigStatus,
  getConfig,
  logConfiguration,
  requiredVars,
  optionalVars
};
