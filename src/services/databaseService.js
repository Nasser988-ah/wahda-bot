const { PrismaClient } = require('@prisma/client');

class DatabaseService {
  constructor() {
    this.prisma = null;
    this.isConnected = false;
  }

  async connect() {
    try {
      if (!this.prisma) {
        const dbUrl = process.env.DATABASE_URL;
        if (!dbUrl) {
          throw new Error('DATABASE_URL environment variable is not set');
        }

        const poolMax = process.env.DATABASE_POOL_MAX || 10;
        const pooledDatabaseUrl = dbUrl.includes('?') 
          ? `${dbUrl}&schema=public&connection_limit=${poolMax}`
          : `${dbUrl}?schema=public&connection_limit=${poolMax}`;

        this.prisma = new PrismaClient({
          datasources: {
            db: {
              url: pooledDatabaseUrl
            }
          },
          log: process.env.NODE_ENV === 'production' ? ['error'] : ['warn', 'error'],
          errorFormat: 'pretty'
        });
      }

      await this.prisma.$connect();
      this.isConnected = true;
      console.log('✅ Database connected successfully');
      
      return this.prisma;
    } catch (error) {
      console.error('❌ Database connection failed:', error);
      throw error;
    }
  }

  async disconnect() {
    try {
      if (this.prisma && this.isConnected) {
        await this.prisma.$disconnect();
        this.isConnected = false;
        console.log('✅ Database disconnected');
      }
    } catch (error) {
      console.error('❌ Database disconnect failed:', error);
    }
  }

  getClient() {
    if (!this.isConnected) {
      // Auto-connect if not connected
      if (!this.prisma) {
        const dbUrl = process.env.DATABASE_URL;
        if (!dbUrl) {
          throw new Error('DATABASE_URL environment variable is not set');
        }

        const poolMax = process.env.DATABASE_POOL_MAX || 10;
        const pooledDatabaseUrl = dbUrl.includes('?') 
          ? `${dbUrl}&schema=public&connection_limit=${poolMax}`
          : `${dbUrl}?schema=public&connection_limit=${poolMax}`;

        this.prisma = new PrismaClient({
          datasources: {
            db: {
              url: pooledDatabaseUrl
            }
          },
          log: process.env.NODE_ENV === 'production' ? ['error'] : ['warn', 'error'],
          errorFormat: 'pretty'
        });
      }
      this.isConnected = true;
      console.log('✅ Database auto-connected');
    }
    return this.prisma;
  }

  async healthCheck() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'healthy', connected: this.isConnected };
    } catch (error) {
      return { status: 'unhealthy', error: error.message, connected: false };
    }
  }
}

// Singleton instance
const databaseService = new DatabaseService();

module.exports = databaseService;
