#!/bin/bash

# WhatsApp Bot Deployment Script for Replit
# This script clones the bot from GitHub and sets it up on Replit

set -e

echo "🚀 Starting WhatsApp Bot Deployment on Replit..."
echo "================================================"

# Configuration
REPO_URL="https://github.com/Nasser988-ah/wahda-bot.git"
PROJECT_NAME="wahda-bot"

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Step 1: Clone the repository
print_status "Step 1: Cloning repository from GitHub..."
if [ -d "$PROJECT_NAME" ]; then
    print_warning "Directory $PROJECT_NAME already exists. Removing..."
    rm -rf "$PROJECT_NAME"
fi

git clone "$REPO_URL"
cd "$PROJECT_NAME"
print_status "✅ Repository cloned successfully"

# Step 2: Install dependencies
print_status "Step 2: Installing Node.js dependencies..."
npm install
print_status "✅ Dependencies installed"

# Step 3: Create environment file
print_status "Step 3: Setting up environment variables..."
if [ ! -f ".env" ]; then
    cat > .env << 'EOF'
# Database Configuration (Use Replit's PostgreSQL)
DATABASE_URL="${DATABASE_URL:-postgresql://user:pass@localhost:5432/whatsappbot}"

# Redis Configuration (Use Replit's Redis or Upstash)
REDIS_URL="${REDIS_URL:-redis://localhost:6379}"
UPSTASH_REDIS_REST_URL="${UPSTASH_REDIS_REST_URL:-}"
UPSTASH_REDIS_REST_TOKEN="${UPSTASH_REDIS_REST_TOKEN:-}"

# JWT Secret (Generate a secure random string)
JWT_SECRET="${JWT_SECRET:-your-super-secret-jwt-key-change-this-in-production}"

# Groq AI API Key (Get from https://console.groq.com)
GROQ_API_KEY="${GROQ_API_KEY:-}"

# Hugging Face Token (Optional, for AI features)
HUGGINGFACE_TOKEN="${HUGGINGFACE_TOKEN:-}"

# Server Configuration
PORT="${PORT:-3000}"
NODE_ENV="${NODE_ENV:-production}"

# CORS Origin (Set your frontend domain)
CORS_ORIGIN="${CORS_ORIGIN:-*}"
EOF
    print_status "✅ .env file created"
else
    print_warning ".env file already exists, skipping creation"
fi

# Step 4: Setup Prisma database
print_status "Step 4: Setting up database with Prisma..."
npx prisma generate
print_status "✅ Prisma client generated"

# Note about database migrations
print_warning "Note: Database migrations should be run manually"
print_warning "Run: npx prisma migrate deploy"

# Step 5: Create necessary directories
print_status "Step 5: Creating required directories..."
mkdir -p sessions
mkdir -p logs
print_status "✅ Directories created"

# Step 6: Health check
print_status "Step 6: Running health checks..."
if command -v node &> /dev/null; then
    NODE_VERSION=$(node --version)
    print_status "✅ Node.js version: $NODE_VERSION"
else
    print_error "Node.js is not installed!"
    exit 1
fi

# Step 7: Build/start instructions
echo ""
echo "================================================"
echo "🎉 Deployment preparation complete!"
echo "================================================"
echo ""
echo "Next steps:"
echo "1. Set up your environment variables in Replit Secrets:"
echo "   - DATABASE_URL (PostgreSQL connection string)"
echo "   - REDIS_URL or UPSTASH_REDIS_REST_URL"
echo "   - JWT_SECRET (random secure string)"
echo "   - GROQ_API_KEY (from https://console.groq.com)"
echo ""
echo "2. Run database migrations:"
echo "   npx prisma migrate deploy"
echo ""
echo "3. Start the bot:"
echo "   npm start"
echo "   OR"
echo "   node index.js"
echo ""
echo "4. For development with auto-restart:"
echo "   npm run dev"
echo ""
echo "📁 Project location: $(pwd)"
echo "================================================"
