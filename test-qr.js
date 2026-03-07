const { default: makeWASocket, useMultiFileAuthState } = require("@whiskeysockets/baileys");
const pino = require("pino");
const path = require("path");

async function testQR() {
  try {
    console.log("🧪 Testing QR generation...");
    
    const sessionDir = path.resolve("./test-session");
    const fs = require('fs');
    
    // Clean up test session
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
    
    // Create session directory
    await fs.promises.mkdir(sessionDir, { recursive: true });
    
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    
    console.log("📱 Creating socket...");
    const sock = makeWASocket({
      auth: state,
      logger: pino({ level: "info" }), // Show all logs
      connectTimeoutMs: 30000,
      retryRequestDelayMs: 1000,
      maxRetries: 2,
      browser: ["TestBot", "Chrome", "120.0.0.0"],
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });
    
    let qrReceived = false;
    
    sock.ev.on("connection.update", (update) => {
      console.log("📊 Connection update:", update);
      
      if (update.qr) {
        console.log("✅ QR received!");
        qrReceived = true;
        console.log("QR String length:", update.qr.length);
        console.log("QR String preview:", update.qr.substring(0, 50) + "...");
        
        // Clean up
        setTimeout(() => {
          sock.end();
          process.exit(0);
        }, 1000);
      }
      
      if (update.connection === "close") {
        console.log("❌ Connection closed:", update.lastDisconnect?.error?.output?.statusCode);
        if (!qrReceived) {
          console.log("❌ No QR received before connection closed");
          process.exit(1);
        }
      }
    });
    
    sock.ev.on("creds.update", saveCreds);
    
    // Timeout after 30 seconds
    setTimeout(() => {
      if (!qrReceived) {
        console.log("❌ Timeout - no QR received");
        sock.end();
        process.exit(1);
      }
    }, 30000);
    
  } catch (error) {
    console.error("❌ Test failed:", error);
    process.exit(1);
  }
}

testQR();
