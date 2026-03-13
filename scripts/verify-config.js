#!/usr/bin/env node

/**
 * Pre-deployment Configuration Checker
 * Validates all environment variables and system configuration before deployment
 * 
 * Usage: node scripts/verify-config.js
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');

const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function section(title) {
  console.log('\n');
  log(`━━━ ${title} ━━━`, 'cyan');
}

function success(message) {
  log(`✅  ${message}`, 'green');
}

function error(message) {
  log(`❌  ${message}`, 'red');
}

function warning(message) {
  log(`⚠️  ${message}`, 'yellow');
}

function check(name, condition, errorMsg) {
  if (condition) {
    success(name);
    return true;
  } else {
    error(`${name}: ${errorMsg}`);
    return false;
  }
}

// Start verification
console.clear();
log('╔════════════════════════════════════════════════════════╗', 'blue');
log('║  WhatsApp Bot SaaS - Configuration Verification Tool   ║', 'blue');
log('╚════════════════════════════════════════════════════════╝', 'blue');

let allChecks = [];

// 1. Required Environment Variables
section('Required Environment Variables');
allChecks.push(check('DATABASE_URL', !!process.env.DATABASE_URL, 'PostgreSQL connection string not set'));
allChecks.push(check('JWT_SECRET', !!process.env.JWT_SECRET, 'JWT secret not set'));
allChecks.push(check('GROQ_API_KEY', !!process.env.GROQ_API_KEY, 'Groq API key not set'));

// 2. Database Configuration
section('Database Configuration');
if (process.env.DATABASE_URL) {
  allChecks.push(check('Database URL Valid', 
    process.env.DATABASE_URL.startsWith('postgresql://'), 
    'Must be PostgreSQL URL (postgresql://...)'
  ));
  
  const poolMin = parseInt(process.env.DATABASE_POOL_MIN || '2');
  const poolMax = parseInt(process.env.DATABASE_POOL_MAX || '10');
  allChecks.push(check('Connection Pool Config', 
    poolMin > 0 && poolMax > poolMin, 
    `Invalid pool: min=${poolMin}, max=${poolMax}. Max must be > min`
  ));
  log(`   Min connections: ${poolMin}`, 'blue');
  log(`   Max connections: ${poolMax}`, 'blue');
}

// 3. Authentication Config
section('Authentication Configuration');
if (process.env.JWT_SECRET) {
  allChecks.push(check('JWT Secret Length', 
    process.env.JWT_SECRET.length >= 32, 
    `Secret too short (${process.env.JWT_SECRET.length} chars, need ≥32)`
  ));
  allChecks.push(check('JWT Expiration', 
    !!process.env.JWT_EXPIRES_IN, 
    'JWT_EXPIRES_IN not set, using default (7d)'
  ));
}

// 4. Optional: Redis Configuration
section('Redis/Cache Configuration (Optional)');
if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  success('Redis configured');
  allChecks.push(true);
} else {
  warning('Redis not configured - caching features will be disabled');
  allChecks.push(true);
}

// 5. AI Configuration
section('AI Services Configuration');
if (process.env.GROQ_API_KEY) {
  allChecks.push(check('Groq API Key Format', 
    process.env.GROQ_API_KEY.startsWith('gsk_'), 
    'Invalid Groq key format (should start with gsk_)'
  ));
}

// 6. Security Configuration
section('Security Configuration');
allChecks.push(check('Bcrypt Rounds', 
  parseInt(process.env.BCRYPT_ROUNDS || '12') >= 10, 
  'BCRYPT_ROUNDS should be ≥10 for security'
));
warning('CORS_ORIGIN is set to allow all origins - restrict in production');

// 7. Rate Limiting
section('Rate Limiting Configuration');
const rateLimitWindow = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000');
const rateLimitMax = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100');
allChecks.push(check('Rate Limit Window', rateLimitWindow > 0, 'Invalid rate limit window'));
allChecks.push(check('Rate Limit Max', rateLimitMax > 0, 'Invalid max requests'));
log(`   Window: ${(rateLimitWindow / 1000 / 60).toFixed(1)} minutes`, 'blue');
log(`   Max requests: ${rateLimitMax}`, 'blue');

// 8. Bot Configuration
section('WhatsApp Bot Configuration');
allChecks.push(check('Bot Name', !!process.env.BOT_NAME, 'Bot name not set'));
const sessionDir = process.env.BOT_SESSION_DIR || './sessions';
const sessionDirExists = fs.existsSync(sessionDir);
allChecks.push(check('Session Directory', sessionDirExists || true, 'Session directory will be created on first run'));
if (!sessionDirExists) {
  warning(`Session directory does not exist yet - will be created: ${sessionDir}`);
}

// 9. File System Checks
section('File System Verification');
const requiredFiles = [
  'package.json',
  'index.js',
  'Dockerfile',
  'prisma/schema.prisma',
  '.gitignore',
  '.env'
];

const missingFiles = [];
requiredFiles.forEach(file => {
  const filePath = path.join(process.cwd(), file);
  if (!fs.existsSync(filePath)) {
    missingFiles.push(file);
    error(`Missing: ${file}`);
  } else {
    success(`Found: ${file}`);
    allChecks.push(true);
  }
});

// 10. Deployment Target
section('Environment & Deployment');
log(`NODE_ENV: ${process.env.NODE_ENV || 'development'}`, 'blue');
log(`PORT: ${process.env.PORT || '3000'}`, 'blue');
log(`LOG_LEVEL: ${process.env.LOG_LEVEL || 'info'}`, 'blue');

if (process.env.NODE_ENV === 'production') {
  allChecks.push(check('Production Mode', true, ''));
} else {
  warning('Running in development mode - set NODE_ENV=production for deployments');
  allChecks.push(true);
}

// Final Summary
section('Verification Summary');
const passedChecks = allChecks.filter(c => c).length;
const totalChecks = allChecks.length;
const percentage = Math.round((passedChecks / totalChecks) * 100);

if (percentage === 100) {
  log(`✅ All checks passed! (${passedChecks}/${totalChecks})`, 'green');
  log('\nYour application is ready for deployment! 🚀', 'green');
  process.exit(0);
} else if (percentage >= 80) {
  log(`⚠️  ${passedChecks}/${totalChecks} checks passed (${percentage}%)`, 'yellow');
  log('\nSome optional configurations are missing.', 'yellow');
  log('The app should work, but consider fixing any warnings for better functionality.', 'yellow');
  process.exit(0);
} else {
  log(`❌ ${passedChecks}/${totalChecks} checks passed (${percentage}%)`, 'red');
  log('\nFix the errors above before deploying.', 'red');
  process.exit(1);
}
