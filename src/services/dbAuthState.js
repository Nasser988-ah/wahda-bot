const databaseService = require('./databaseService');
const { initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');

function getPrisma() {
  return databaseService.getClient();
}

async function useDBAuthState(shopId) {
  
  async function readSession() {
    try {
      const session = await getPrisma().whatsAppSession.findUnique({
        where: { shopId }
      });
      if (!session) return null;
      return {
        creds: JSON.parse(session.creds, BufferJSON.reviver),
        keys: JSON.parse(session.keys, BufferJSON.reviver)
      };
    } catch (err) {
      console.error(`Error reading session for ${shopId}:`, err);
      return null;
    }
  }
  
  async function writeSession(creds, keys) {
    try {
      await getPrisma().whatsAppSession.upsert({
        where: { shopId },
        update: {
          creds: JSON.stringify(creds, BufferJSON.replacer),
          keys: JSON.stringify(keys, BufferJSON.replacer),
          updatedAt: new Date()
        },
        create: {
          id: shopId,
          shopId,
          creds: JSON.stringify(creds, BufferJSON.replacer),
          keys: JSON.stringify(keys || {}, BufferJSON.replacer),
          updatedAt: new Date()
        }
      });
    } catch (err) {
      console.error(`Error saving session for ${shopId}:`, err);
    }
  }
  
  async function deleteSession() {
    try {
      await getPrisma().whatsAppSession.deleteMany({ where: { shopId } });
    } catch (err) {
      console.error(`Error deleting session for ${shopId}:`, err);
    }
  }
  
  // Load existing session
  const saved = await readSession();
  
  let creds = saved?.creds || initAuthCreds();
  let keys = saved?.keys || {};
  
  return {
    state: {
      creds,
      keys: {
        get: (type, ids) => {
          const data = {};
          for (const id of ids) {
            const value = keys[`${type}-${id}`];
            if (value) data[id] = value;
          }
          return data;
        },
        set: async (data) => {
          for (const category of Object.keys(data)) {
            for (const id of Object.keys(data[category])) {
              const value = data[category][id];
              if (value) {
                keys[`${category}-${id}`] = value;
              } else {
                delete keys[`${category}-${id}`];
              }
            }
          }
          await writeSession(creds, keys);
        }
      }
    },
    saveCreds: async () => {
      await writeSession(creds, keys);
    },
    deleteSession
  };
}

module.exports = { useDBAuthState };
