#!/usr/bin/env node

/**
 * AI-Agent CLI
 * Run: node ai-agent-cli.js
 * 
 * This script runs a standalone WhatsApp AI Agent that:
 * - Uses DeepSeek API for smart responses
 * - Has a pre-made menu (no database needed)
 * - Collects customer details for orders
 * - Sends orders to owner via WhatsApp
 * - Generates QR code for easy connection
 */

require('dotenv').config();
const { AIAgent } = require('./src/bot/ai-agent');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

console.log(`
╔══════════════════════════════════════════════════════════╗
║           🤖 AI AGENT - وكيل خدمة العملاء الذكي          ║
╚══════════════════════════════════════════════════════════╝

📋 FEATURES:
   ✓ Smart AI responses with DeepSeek
   ✓ Pre-made menu (no database required)
   ✓ Collects customer orders end-to-end
   ✓ Sends order notifications to owner
   ✓ Typo-tolerant product matching

🔧 SETUP:
   1. Set DEEPSEEK_API_KEY in .env
   2. Set SHOP_PHONE (owner's WhatsApp number)
   3. Edit products in src/bot/ai-agent.js
   4. Run: node ai-agent-cli.js

💡 COMMANDS:
   menu     - Show available products
   status   - Check connection status
   qr       - Get current QR code
   orders   - View recent orders
   help     - Show this help
   exit     - Stop the agent

`);

// Check required config
if (!process.env.DEEPSEEK_API_KEY) {
  console.log('⚠️ WARNING: DEEPSEEK_API_KEY not set in .env');
  console.log('   AI responses will use fallback mode.\n');
}

if (!process.env.SHOP_PHONE) {
  console.log('⚠️ WARNING: SHOP_PHONE not set in .env');
  console.log('   Order notifications will not be sent to owner.\n');
}

// Start the agent
const agent = new AIAgent();
agent.start().catch(console.error);

// CLI loop
function prompt() {
  rl.question('AI-Agent> ', async (input) => {
    const cmd = input.trim().toLowerCase();
    
    switch (cmd) {
      case 'menu':
      case 'قائمة':
        console.log('\n📋 AVAILABLE PRODUCTS:');
        const { SHOP_CONFIG } = require('./src/bot/ai-agent');
        SHOP_CONFIG.menu.forEach(p => {
          console.log(`   ${p.id}. ${p.name} - ${p.price} ${SHOP_CONFIG.currency}`);
        });
        console.log('');
        break;
        
      case 'status':
      case 'الحالة':
        const status = agent.getStatus();
        console.log('\n📊 STATUS:');
        console.log(`   Connected: ${status.connected ? '✅' : '❌'}`);
        console.log(`   QR Code: ${status.hasQR ? '✅ Available' : '❌ Not available'}`);
        console.log(`   Shop: ${status.shopName}`);
        console.log('');
        break;
        
      case 'qr':
        const qrPath = path.join('./ai-agent-session', 'qr-code.png');
        if (fs.existsSync(qrPath)) {
          console.log(`\n📱 QR Code saved at: ${qrPath}`);
          console.log('   Scan this QR code with WhatsApp to connect.\n');
        } else {
          console.log('\n⏳ QR code not generated yet. Waiting for connection...\n');
        }
        break;
        
      case 'orders':
      case 'الطلبات':
        const ordersPath = path.join('./ai-agent-session', 'orders.json');
        if (fs.existsSync(ordersPath)) {
          const orders = JSON.parse(fs.readFileSync(ordersPath, 'utf8'));
          console.log(`\n🛒 RECENT ORDERS (${orders.length} total):`);
          orders.slice(-5).forEach((o, i) => {
            console.log(`\n   ${i + 1}. ${o.name} - ${o.total} EGP`);
            console.log(`      Items: ${o.items.length}`);
            console.log(`      Time: ${new Date(o.timestamp).toLocaleString()}`);
            console.log(`      Status: ${o.status}`);
          });
          console.log('');
        } else {
          console.log('\n📭 No orders yet.\n');
        }
        break;
        
      case 'help':
      case 'مساعدة':
        console.log(`
📖 COMMANDS:
   menu     - Show available products
   status   - Check connection status
   qr       - Get current QR code location
   orders   - View recent orders
   help     - Show this help
   exit     - Stop the agent

💡 HOW IT WORKS:
   1. Customer sends "قائمة" to see products
   2. Customer types product number or name
   3. Bot collects name, phone, and address
   4. Order is sent to owner's WhatsApp
   5. Order is saved to orders.json

`);
        break;
        
      case 'exit':
      case 'quit':
      case 'خروج':
        console.log('\n👋 Stopping AI Agent...\n');
        rl.close();
        process.exit(0);
        break;
        
      default:
        if (cmd) {
          console.log(`Unknown command: ${cmd}. Type "help" for available commands.\n`);
        }
    }
    
    prompt();
  });
}

// Start CLI after a short delay
setTimeout(prompt, 1000);

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down...\n');
  rl.close();
  process.exit(0);
});
