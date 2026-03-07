async function handleMessage(sock, msg) {
  try {
    const from = msg.key.remoteJid;
    
    // Extract text from different message types
    const text =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      msg.message?.imageMessage?.caption ||
      msg.message?.videoMessage?.caption ||
      "";

    console.log(`📩 Message from ${from}: "${text}"`);
    console.log(`🔍 Message type:`, Object.keys(msg.message || {}));

    if (!text || text.trim() === "") {
      console.log(`⚠️ Empty message, skipping reply`);
      return;
    }

    console.log(`📤 Sending reply to ${from}...`);
    
    try {
      // Use the most reliable message format
      const messageSent = await sock.sendMessage(
        from, 
        { text: `OK` },
        { 
          // Add these options for better delivery
          ephemeralExpiration: 86400, // 24 hours
          schedulingTime: Date.now() + 1000 // Send after 1 second
        }
      );
      
      console.log(`✅ Reply sent successfully. Message ID: ${messageSent.key.id}`);
      
      // Wait a moment to check if it gets delivered
      setTimeout(() => {
        console.log(`🔍 Checking delivery status for message ${messageSent.key.id}`);
      }, 3000);
      
    } catch (error) {
      console.error(`❌ Failed to send message:`, error.message);
      
      // Try fallback method
      try {
        await sock.sendMessage(from, { text: `Test reply` });
        console.log(`✅ Fallback reply sent`);
      } catch (fallbackError) {
        console.error(`❌ Fallback also failed:`, fallbackError.message);
      }
    }
  } catch (error) {
    console.error(`❌ Error handling message:`, error.message);
  }
}

module.exports = { handleMessage };
