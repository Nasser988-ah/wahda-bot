const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const qrcode = require("qrcode-terminal");
const path = require("path");
const { handleMessage } = require("./messageHandler");

const SESSION_DIR = process.env.BOT_SESSION_DIR || "./sessions";

async function initBot() {
  const { state, saveCreds } = await useMultiFileAuthState(
    path.resolve(SESSION_DIR)
  );

const sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }),
    connectTimeoutMs: 60000,
    retryRequestDelayMs: 3000,
    maxRetries: 5,
    browser: ["ZakiBot", "Chrome", "120.0.0.0"],
    syncFullHistory: false,
    markOnlineOnConnect: true,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("\n📱 Scan this QR code with WhatsApp:\n");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log("🔌 Connection closed. Status:", statusCode, "Reconnecting:", shouldReconnect);
      if (shouldReconnect) {
        setTimeout(() => initBot(), 3000);
      }
    } else if (connection === "open") {
      console.log("📱 WhatsApp connected successfully!");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.key.fromMe && msg.message && msg.key.remoteJid) {
        // Add delay to prevent rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));
        await handleMessage(sock, msg);
      }
    }
  });

  // Add message acknowledgment tracking
  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.key.fromMe && msg.message) {
        console.log(`📨 Incoming message ID: ${msg.key.id}`);
      }
    }
  });

  // Track message status and delivery
  sock.ev.on("message-receipt.update", (updates) => {
    for (const update of updates) {
      console.log(`📤 Message receipt: ${update.key.id} - ${update.receipt.type} - Status: ${update.receipt.read ? 'read' : 'delivered'}`);
    }
  });

  // Track our own message status
  sock.ev.on("messages.update", (updates) => {
    for (const update of updates) {
      if (update.key.fromMe) {
        console.log(`📤 Our message status: ${update.key.id} - Status: ${update.status || 'unknown'}`);
      }
    }
  });

  return sock;
}

module.exports = { initBot };
