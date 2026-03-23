#!/bin/bash

# PubWeb Deployment Script for Namecheap Server
# Run this after SSH-ing into the server:
# ssh pubwvxel@server146.web-hosting.com

set -e

echo "🚀 PubWeb Deployment Starting..."

# Setup
mkdir -p ~/pubweb
cd ~/pubweb

# Clone or update repo
if [ -d ".git" ]; then
  echo "📦 Updating existing repo..."
  git pull origin main
else
  echo "📦 Cloning repo..."
  git clone https://github.com/skyeknighton/pubweb.git .
fi

# Install dependencies
echo "📚 Installing dependencies..."
npm install

# Build
echo "🔨 Building project..."
npm run build

# Setup environment
echo "⚙️ Setting up environment..."
cp .env.example .env
# Edit .env with production values:
# - TRACKER_URL=http://pubweb.online:4000
# - NODE_ENV=production

# Install/Update PM2
echo "🛡️ Setting up process manager..."
npm install -g pm2 2>/dev/null || true

# Stop old processes
pm2 delete tracker peer 2>/dev/null || true

# Start services
echo "🚀 Starting services..."
pm2 start dist/main/tracker/index.js --name "tracker" -- 
pm2 start start-peer.js --name "peer"

# Save PM2 config
pm2 save
pm2 startup

# Check status
echo "✅ Deployment complete!"
pm2 status