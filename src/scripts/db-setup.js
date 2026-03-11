const { execSync } = require('child_process');
const path = require('path');

console.log('🔄 Running database setup...');

try {
  // Run Prisma db push to create tables
  execSync('npx prisma db push --accept-data-loss', {
    cwd: path.resolve(__dirname, '..'),
    stdio: 'inherit',
    env: { ...process.env }
  });
  console.log('✅ Database setup complete');
} catch (error) {
  console.error('❌ Database setup failed:', error.message);
  console.log('⚠️ Continuing anyway...');
}
