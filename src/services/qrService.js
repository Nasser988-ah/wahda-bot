const QRCode = require('qrcode');
const BotManager = require('../bot/botManager');
const fs = require('fs');
const path = require('path');

class QRService {
  constructor() {
    this.botManager = new BotManager();
    this.activeConnections = new Map(); // shopId -> connection info
    this.qrCallbacks = new Map(); // shopId -> callback function
  }

  async generateQR(shopId, force = false) {
    try {
      console.log(`🔄 Generating QR for shop: ${shopId} (force: ${force})`);

      // Check current connection state
      const connectionState = this.botManager.getConnectionState(shopId);
      
      // If connected, return already connected
      if (connectionState === 'connected') {
        return {
          connected: true,
          status: 'already_connected',
          shopId,
          message: 'WhatsApp is already connected'
        };
      }

      // If already connecting, wait for it instead of creating new connection
      if (connectionState === 'connecting') {
        console.log(`⏳ Already connecting shop ${shopId}, waiting for existing connection...`);
        
        // Return existing promise if available
        const existingConnection = this.activeConnections.get(shopId);
        if (existingConnection && existingConnection.qrImage) {
          return {
            qr: existingConnection.qrImage.split(',')[1],
            qrString: existingConnection.qrString,
            shopId,
            status: 'waiting_for_scan'
          };
        }
        
        // Wait up to 30 seconds for connection to complete
        return new Promise((resolve, reject) => {
          let waitTime = 0;
          const checkInterval = setInterval(() => {
            waitTime += 1000;
            const conn = this.activeConnections.get(shopId);
            
            if (conn && conn.qrImage) {
              clearInterval(checkInterval);
              resolve({
                qr: conn.qrImage.split(',')[1],
                qrString: conn.qrString,
                shopId,
                status: 'waiting_for_scan'
              });
            }
            
            if (waitTime > 30000) {
              clearInterval(checkInterval);
              reject(new Error('Timeout waiting for existing connection'));
            }
          }, 1000);
        });
      }

      // Initialize WhatsApp connection for this shop
      const qrPromise = new Promise((resolve, reject) => {
        let qrReceived = false;
        let retryCount = 0;
        const maxRetries = 5;
        
        let timeout = setTimeout(() => {
          if (!qrReceived) {
            console.log(`⏰ QR generation timeout for shop ${shopId} after 120 seconds`);
            reject(new Error('QR generation timeout - WhatsApp not responding'));
          }
        }, 120000); // 2 minute timeout

        const qrCallback = async (qrString) => {
          if (qrReceived) return; // Prevent multiple callbacks
          qrReceived = true;
          clearTimeout(timeout);
          
          console.log(`📱 QR callback triggered for shop ${shopId}`);
          
          try {
            console.log(`📱 QR received for shop ${shopId}`);
            
            // Generate QR code image
            const qrImage = await QRCode.toDataURL(qrString, {
              width: 200,
              margin: 2,
              color: {
                dark: '#000000',
                light: '#FFFFFF'
              },
              errorCorrectionLevel: 'M'
            });

            // Store connection info
            this.activeConnections.set(shopId, {
              qrString,
              qrImage,
              createdAt: new Date(),
              status: 'waiting_for_scan'
            });

            resolve({
              qr: qrImage.split(',')[1], // Remove data:image/png;base64, prefix
              qrString: qrString,
              shopId,
              status: 'waiting_for_scan'
            });
          } catch (error) {
            console.error(`❌ Error processing QR for shop ${shopId}:`, error);
            reject(error);
          }
        };

        // Store callback for this shop
        this.qrCallbacks.set(shopId, qrCallback);

        // Start bot connection with retry logic
        const startConnection = () => {
          if (retryCount >= maxRetries) {
            console.log(`❌ Max retries (${maxRetries}) reached for shop ${shopId}`);
            clearTimeout(timeout);
            reject(new Error('Max connection retries reached'));
            return;
          }
          
          retryCount++;
          console.log(`🤖 Starting connection attempt ${retryCount}/${maxRetries} for shop ${shopId}`);
          
          this.botManager.connectShop(shopId, qrCallback).then(() => {
            console.log(`✅ Bot connection initiated for shop ${shopId} (attempt ${retryCount})`);
          }).catch(error => {
            console.error(`❌ Bot connection failed for shop ${shopId} (attempt ${retryCount}):`, error.message);
            
            // Retry after delay if QR not yet received
            if (!qrReceived && retryCount < maxRetries) {
              console.log(`🔄 Retrying connection for shop ${shopId} in 5 seconds...`);
              setTimeout(startConnection, 5000);
            }
          });
        };
        
        // Start first connection attempt
        startConnection();
      });

      return await qrPromise;

    } catch (error) {
      console.error(`❌ QR generation failed for shop ${shopId}:`, error);
      throw error;
    }
  }

  async cleanupShop(shopId) {
    try {
      // Disconnect existing connection if any
      if (this.botManager.connections.has(shopId)) {
        try {
          await this.botManager.disconnectShop(shopId);
        } catch (disconnectError) {
          console.log(`⚠️ Disconnect warning for shop ${shopId}:`, disconnectError.message);
          // Continue cleanup even if disconnect fails
        }
      }
      
      // Clean up local data only - DON'T delete session folder
      this.activeConnections.delete(shopId);
      this.qrCallbacks.delete(shopId);
      
      console.log(`🧹 Cleaned up connection for shop ${shopId}`);
    } catch (error) {
      console.error(`❌ Failed to cleanup shop ${shopId}:`, error);
    }
  }

  async getConnectionStatus(shopId) {
    try {
      // First check if actually connected via BotManager
      const isConnected = this.botManager.isShopConnected(shopId);
      const connectionState = this.botManager.getConnectionState(shopId);
      
      console.log(`📊 Status check for ${shopId}: connected=${isConnected}, state=${connectionState}`);
      
      if (isConnected) {
        const connection = this.activeConnections.get(shopId);
        if (connection) {
          connection.status = 'connected';
          connection.connectedAt = connection.connectedAt || new Date();
        }
        return {
          connected: true,
          status: 'connected',
          shopId,
          connectedAt: connection?.connectedAt || new Date()
        };
      }

      // Check if connecting
      const isConnecting = this.botManager.isConnecting(shopId);
      if (isConnecting) {
        return {
          connected: false,
          status: 'connecting',
          shopId,
          message: 'Connecting to WhatsApp...'
        };
      }

      const connection = this.activeConnections.get(shopId);
      
      if (!connection) {
        return {
          connected: false,
          status: 'not_started',
          shopId
        };
      }

      // Check if QR is too old (regenerate after 5 minutes)
      const age = Date.now() - connection.createdAt.getTime();
      const isExpired = age > 300000; // 5 minutes
      
      if (isExpired) {
        await this.cleanupShop(shopId);
        return {
          connected: false,
          status: 'expired',
          shopId,
          message: 'QR code expired. Please generate a new one.'
        };
      }

      return {
        connected: false,
        status: connection.status || 'waiting_for_scan',
        shopId,
        qrGenerated: !!connection.qrImage,
        createdAt: connection.createdAt,
        message: 'QR code ready - scan with WhatsApp to connect',
        age: Math.floor(age / 1000) // Age in seconds
      };

    } catch (error) {
      console.error(`❌ Status check failed for shop ${shopId}:`, error);
      return {
        connected: false,
        status: 'error',
        shopId,
        error: error.message
      };
    }
  }

  async disconnectShop(shopId) {
    try {
      // Disconnect from BotManager
      await this.botManager.disconnectShop(shopId);
      
      // Clean up local data
      this.activeConnections.delete(shopId);
      this.qrCallbacks.delete(shopId);
      
      return {
        success: true,
        message: 'Shop disconnected successfully'
      };
    } catch (error) {
      console.error(`❌ Disconnect failed for shop ${shopId}:`, error);
      throw error;
    }
  }

  
  // Clean up old connections
  cleanup() {
    const now = new Date();
    for (const [shopId, connection] of this.activeConnections.entries()) {
      const age = now - connection.createdAt;
      if (age > 3600000) { // 1 hour
        this.activeConnections.delete(shopId);
      }
    }
  }
}

// Singleton instance
const qrService = new QRService();

// Cleanup every 10 minutes
setInterval(() => qrService.cleanup(), 600000);

module.exports = qrService;
