const QRCode = require('qrcode');
const botManager = require('../bot/botManager');

class QRService {
  constructor() {
    this.botManager = botManager;
    this.activeConnections = new Map(); // shopId -> { qrString, qrImage, createdAt, status }
    this.connectingTimers = new Map(); // shopId -> timeout for stuck-state recovery
  }

  async generateQR(shopId) {
    try {
      console.log(`🔄 [QR] Generating for shop: ${shopId}`);

      const connectionState = this.botManager.getConnectionState(shopId);

      // Already connected
      if (connectionState === 'connected') {
        return { connected: true, status: 'already_connected', shopId };
      }

      // If we already have a fresh QR stored, return it
      const existing = this.activeConnections.get(shopId);
      if (existing && existing.qrImage) {
        const age = Date.now() - existing.createdAt.getTime();
        if (age < 45000) { // QR valid for ~45s
          console.log(`📱 [QR] Returning cached QR for ${shopId} (${Math.round(age/1000)}s old)`);
          return {
            qr: existing.qrImage.split(',')[1],
            shopId,
            status: 'waiting_for_scan'
          };
        }
      }

      // If already connecting/waiting for QR, wait for it (max 30s)
      if (connectionState === 'connecting' || connectionState === 'qr') {
        console.log(`⏳ [QR] Already connecting ${shopId}, waiting for QR...`);
        return await this._waitForQR(shopId, 30000);
      }

      // Start fresh connection
      return await this._startConnection(shopId);

    } catch (error) {
      console.error(`❌ [QR] Generation failed for ${shopId}:`, error.message);
      // Reset stuck state so next attempt can proceed
      this.botManager.connectionStates.set(shopId, 'not_started');
      throw error;
    }
  }

  async _startConnection(shopId) {
    return new Promise((resolve, reject) => {
      let resolved = false;

      // Timeout: 60s to get the first QR
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.botManager.connectionStates.set(shopId, 'not_started');
          reject(new Error('QR generation timeout'));
        }
      }, 60000);

      // QR callback — called EVERY time WhatsApp generates a new QR
      const qrCallback = async (qrString) => {
        try {
          const qrImage = await QRCode.toDataURL(qrString, {
            width: 256, margin: 2,
            color: { dark: '#000000', light: '#FFFFFF' },
            errorCorrectionLevel: 'M'
          });

          // Always store the latest QR
          this.activeConnections.set(shopId, {
            qrString, qrImage,
            createdAt: new Date(),
            status: 'waiting_for_scan'
          });

          console.log(`📱 [QR] New QR stored for ${shopId}`);

          // Resolve promise on the first QR only
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            resolve({
              qr: qrImage.split(',')[1],
              shopId,
              status: 'waiting_for_scan'
            });
          }
        } catch (err) {
          console.error(`❌ [QR] Image generation error:`, err.message);
          if (!resolved) { resolved = true; clearTimeout(timeout); reject(err); }
        }
      };

      // Set a stuck-state recovery timer (90s)
      this._setConnectingTimeout(shopId, 90000);

      this.botManager.connectShop(shopId, qrCallback).catch(err => {
        if (!resolved) { resolved = true; clearTimeout(timeout); reject(err); }
      });
    });
  }

  async _waitForQR(shopId, maxWait) {
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      const conn = this.activeConnections.get(shopId);
      if (conn && conn.qrImage) {
        return {
          qr: conn.qrImage.split(',')[1],
          shopId,
          status: 'waiting_for_scan'
        };
      }
      // Check if connected while we waited
      if (this.botManager.getConnectionState(shopId) === 'connected') {
        return { connected: true, status: 'already_connected', shopId };
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    throw new Error('Timeout waiting for QR');
  }

  // Auto-recover from stuck 'connecting' state
  _setConnectingTimeout(shopId, ms) {
    if (this.connectingTimers.has(shopId)) clearTimeout(this.connectingTimers.get(shopId));
    this.connectingTimers.set(shopId, setTimeout(() => {
      const state = this.botManager.getConnectionState(shopId);
      if (state === 'connecting' || state === 'qr') {
        console.log(`⏰ [QR] Resetting stuck state for ${shopId} (was: ${state})`);
        this.botManager.connectionStates.set(shopId, 'not_started');
        this.activeConnections.delete(shopId);
      }
      this.connectingTimers.delete(shopId);
    }, ms));
  }

  async cleanupShop(shopId) {
    try {
      if (this.botManager.connections.has(shopId)) {
        try { await this.botManager.disconnectShop(shopId); } catch (e) { /* ignore */ }
      }
      this.activeConnections.delete(shopId);
      if (this.connectingTimers.has(shopId)) {
        clearTimeout(this.connectingTimers.get(shopId));
        this.connectingTimers.delete(shopId);
      }
      console.log(`🧹 [QR] Cleaned up ${shopId}`);
    } catch (error) {
      console.error(`❌ [QR] Cleanup failed for ${shopId}:`, error.message);
    }
  }

  // Returns current status + QR image if available
  async getConnectionStatus(shopId) {
    try {
      const connectionState = this.botManager.getConnectionState(shopId);
      const isConnected = connectionState === 'connected';

      if (isConnected) {
        this.activeConnections.delete(shopId); // Clean up QR data
        return { connected: true, status: 'connected', shopId };
      }

      const connection = this.activeConnections.get(shopId);

      // Has a QR ready
      if (connection && connection.qrImage) {
        const age = Date.now() - connection.createdAt.getTime();
        if (age > 120000) { // QR older than 2 min → expired
          this.activeConnections.delete(shopId);
          return { connected: false, status: 'expired', shopId, message: 'QR code expired' };
        }
        return {
          connected: false,
          status: 'waiting_for_scan',
          shopId,
          qr: connection.qrImage.split(',')[1],
          qrGenerated: true,
          age: Math.floor(age / 1000)
        };
      }

      // Connecting but no QR yet
      if (connectionState === 'connecting') {
        return { connected: false, status: 'connecting', shopId };
      }

      return { connected: false, status: 'not_started', shopId };
    } catch (error) {
      console.error(`❌ [QR] Status check failed for ${shopId}:`, error.message);
      return { connected: false, status: 'error', shopId, error: error.message };
    }
  }

  async disconnectShop(shopId) {
    try {
      await this.botManager.disconnectShop(shopId);
      this.activeConnections.delete(shopId);
      if (this.connectingTimers.has(shopId)) {
        clearTimeout(this.connectingTimers.get(shopId));
        this.connectingTimers.delete(shopId);
      }
      return { success: true, message: 'Disconnected' };
    } catch (error) {
      console.error(`❌ [QR] Disconnect failed for ${shopId}:`, error.message);
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
