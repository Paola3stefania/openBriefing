#!/bin/bash

# Setup script for local PostgreSQL database

set -e

echo "[SETUP] Setting up local PostgreSQL database for OpenMemory..."

# Check if PostgreSQL is installed
if ! command -v psql &> /dev/null; then
    echo "[ERROR] PostgreSQL not found. Installing..."
    brew install postgresql@14
    brew services start postgresql@14
    sleep 2
fi

# Check if PostgreSQL is running
if ! pg_isready -q; then
    echo "[WARNING] PostgreSQL not running. Starting..."
    brew services start postgresql@14
    sleep 2
fi

# Get current username
USERNAME=$(whoami)

# Create database
echo "[SETUP] Creating database 'openmemory'..."
createdb openmemory 2>/dev/null && echo "[SUCCESS] Database 'openmemory' created" || echo "[INFO] Database 'openmemory' already exists"

# Check if .env exists
if [ ! -f .env ]; then
    echo "[SETUP] Creating .env file from env.example..."
    cp env.example .env
    echo ""
    echo "[WARNING] Please edit .env and add your DATABASE_URL:"
    echo "   DATABASE_URL=postgresql://${USERNAME}@localhost:5432/openmemory"
else
    echo "[INFO] .env file already exists"
    echo ""
    echo "[WARNING] Make sure your .env has:"
    echo "   DATABASE_URL=postgresql://${USERNAME}@localhost:5432/openmemory"
fi

echo ""
echo "[NEXT STEPS]"
echo "   1. Update .env with DATABASE_URL=postgresql://${USERNAME}@localhost:5432/openmemory"
echo "   2. Run: npm run db:migrate"
echo "   3. Test: npx prisma studio"
echo ""
echo "[SUCCESS] Local database setup complete!"
