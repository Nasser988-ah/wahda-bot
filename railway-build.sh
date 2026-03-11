#!/bin/bash
# Build script for Railway

# Set a dummy DATABASE_URL for Prisma generation during build
export DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/postgres"

npm install
npx prisma generate
