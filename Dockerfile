# Railway Dockerfile
FROM node:20-slim

WORKDIR /app

# Install OpenSSL
RUN apt-get update -y && apt-get install -y openssl

# Copy package files
COPY package*.json ./
COPY prisma ./prisma/

# Set a placeholder DATABASE_URL for Prisma generation
ENV DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/postgres"

# Install dependencies and generate Prisma client
RUN npm ci && npx prisma generate

# Copy the rest of the application
COPY . .

# Expose the port
EXPOSE 3000

# Start the application
CMD ["npm", "start"]
