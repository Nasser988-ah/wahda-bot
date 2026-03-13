const { execSync } = require('child_process');
const path = require('path');

console.log('🔄 Running database setup...');

// Check if DATABASE_URL is set
if (!process.env.DATABASE_URL || process.env.DATABASE_URL.trim() === '') {
  console.warn('⚠️ DATABASE_URL is not set. Skipping database setup.');
  console.warn('⚠️ Database features will not be available until DATABASE_URL is configured.');
  console.log('⚠️ Continuing anyway...');
  process.exit(0);
}

try {
  // Run Prisma db push to create tables
  execSync('npx prisma db push --accept-data-loss', {
    cwd: path.resolve(__dirname, '../..'),
    stdio: 'inherit',
    env: { ...process.env }
  });
  console.log('✅ Database setup complete');
} catch (error) {
  console.error('❌ Database setup failed:', error.message);
  console.log('⚠️ Continuing anyway...');
}
