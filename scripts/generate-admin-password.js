/**
 * Admin Password Generator
 * 
 * Run this script to generate a hashed password for the admin dashboard
 * 
 * Usage: node scripts/generate-admin-password.js your_password
 */

const bcrypt = require('bcryptjs');

async function generatePassword() {
    const password = process.argv[2];
    
    if (!password) {
        console.log('❌ Please provide a password');
        console.log('Usage: node scripts/generate-admin-password.js your_password');
        process.exit(1);
    }
    
    if (password.length < 6) {
        console.log('❌ Password must be at least 6 characters');
        process.exit(1);
    }
    
    const hashedPassword = await bcrypt.hash(password, 10);
    
    console.log('\n✅ Admin password generated successfully!\n');
    console.log('Add this to your .env file:');
    console.log('=====================================');
    console.log(`ADMIN_USERNAME=admin`);
    console.log(`ADMIN_PASSWORD=${hashedPassword}`);
    console.log('=====================================\n');
    console.log('Login credentials:');
    console.log(`Username: admin`);
    console.log(`Password: ${password}`);
    console.log('\n📝 Note: You can change ADMIN_USERNAME to any username you prefer');
}

generatePassword().catch(console.error);
