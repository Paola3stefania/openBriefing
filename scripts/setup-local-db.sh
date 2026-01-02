#!/bin/bash

# Setup script for local PostgreSQL database

set -e

echo "🔧 Setting up local PostgreSQL database for UNMute..."

# Check if PostgreSQL is installed
if ! command -v psql &> /dev/null; then
    echo "❌ PostgreSQL not found. Installing..."
    brew install postgresql@14
    brew services start postgresql@14
    sleep 2
fi

# Check if PostgreSQL is running
if ! pg_isready -q; then
    echo "⚠️  PostgreSQL not running. Starting..."
    brew services start postgresql@14
    sleep 2
fi

# Get current username
USERNAME=$(whoami)

# Create database
echo "📦 Creating database 'unmute'..."
createdb unmute 2>/dev/null && echo "✅ Database 'unmute' created" || echo "ℹ️  Database 'unmute' already exists"

# Check if .env exists
if [ ! -f .env ]; then
    echo "📝 Creating .env file from env.example..."
    cp env.example .env
    echo ""
    echo "⚠️  Please edit .env and add your DATABASE_URL:"
    echo "   DATABASE_URL=postgresql://${USERNAME}@localhost:5432/unmute"
else
    echo "📝 .env file already exists"
    echo ""
    echo "⚠️  Make sure your .env has:"
    echo "   DATABASE_URL=postgresql://${USERNAME}@localhost:5432/unmute"
fi

echo ""
echo "🚀 Next steps:"
echo "   1. Update .env with DATABASE_URL=postgresql://${USERNAME}@localhost:5432/unmute"
echo "   2. Run: npm run db:migrate"
echo "   3. Test: npx prisma studio"
echo ""
echo "✅ Local database setup complete!"

