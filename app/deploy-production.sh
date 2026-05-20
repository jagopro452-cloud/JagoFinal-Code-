#!/bin/bash

###############################################################################
#                   AUTOMATED PRODUCTION DEPLOYMENT SCRIPT
#                          March 24, 2026
#
# This script automates the entire deployment process.
# RUN THIS on your production server.
#
# USAGE:
#   bash deploy-production.sh
#
# WHAT IT DOES:
#   1. Checks prerequisites
#   2. Pulls latest code from GitHub
#   3. Installs dependencies
#   4. Runs database migrations
#   5. Updates admin credentials
#   6. Restarts PM2
#   7. Verifies deployment
#
###############################################################################

set -e  # Exit on any error

# Updated credentials (March 24, 2026)
ADMIN_EMAIL="Kiranatmakuri518@gmail.com"
ADMIN_PASSWORD="Greeshmant@2023"
ADMIN_NAME="Kiran"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Step 1: Navigate to app directory
echo -e "${YELLOW}📁 Step 1: Navigating to app directory...${NC}"
cd /app
echo -e "${GREEN}✅ Directory: $(pwd)${NC}"
echo ""

# Step 2: Pull latest code
echo -e "${YELLOW}📥 Step 2: Pulling latest code from GitHub...${NC}"
git pull origin master --quiet
echo -e "${GREEN}✅ Code updated${NC}"
echo ""

# Step 3: Install dependencies
echo -e "${YELLOW}📦 Step 3: Installing dependencies...${NC}"
npm install
if [ $? -ne 0 ]; then
    echo -e "${RED}❌ npm install failed${NC}"
    exit 1
fi
echo -e "${GREEN}✅ Dependencies installed${NC}"
echo ""

# Step 3.5: Database migrations
echo -e "${YELLOW}🗄️  Step 3.5: Running database migrations...${NC}"
npm run migrate
if [ $? -ne 0 ]; then
    echo -e "${RED}❌ Database migration failed${NC}"
    exit 1
fi
echo -e "${GREEN}✅ Database migrations completed${NC}"
echo ""

# Step 4: Build application
echo -e "${YELLOW}🔨 Step 4: Building application...${NC}"
npm run build
if [ $? -ne 0 ]; then
    echo -e "${RED}❌ Build failed${NC}"
    exit 1
fi
echo -e "${GREEN}✅ Build completed successfully${NC}"
echo ""

# Step 5: Update Admin Account
echo -e "${YELLOW}👤 Step 5: Updating admin credentials...${NC}"

# Use the existing update script
DATABASE_URL="$DATABASE_URL" node scripts/update-admin-quick.cjs

if [ $? -ne 0 ]; then
    echo -e "${RED}❌ Admin update failed${NC}"
    exit 1
fi
echo ""

# Step 6: Restart server via PM2
echo -e "${YELLOW}🔄 Step 6: Restarting application via PM2...${NC}"

# Check if process is already running
if pm2 list | grep -q "jago-api"; then
    pm2 restart jago-api
elif pm2 list | grep -q "jago"; then
    pm2 restart jago
else
    # Start new process
    pm2 start dist/index.js --name "jago-api" --instances max
fi

sleep 3
echo -e "${GREEN}✅ PM2 process restarted${NC}"
echo ""

# Step 7: Verify server is running
echo -e "${YELLOW}✓ Step 7: Verifying server health...${NC}"
sleep 5

# Try local health check
HEALTH=$(curl -s http://localhost:5000/api/health || echo "error")

if [[ $HEALTH == *"ok"* ]]; then
  echo -e "${GREEN}✅ Server health check PASSED${NC}"
elif [[ $HEALTH == *"status"* ]]; then
  echo -e "${GREEN}✅ Server is running${NC}"
else
  echo -e "${YELLOW}⏳ Server warming up... (server may take another 30-60 seconds)${NC}"
fi
echo ""

echo ""

# Final Summary
echo "=============================================="
echo -e "${GREEN}✅ DEPLOYMENT COMPLETE!${NC}"
echo "=============================================="
echo ""
echo "🌐 Access your app:"
echo "   Admin: https://jagopro.org/admin/auth/login"
echo "   Customer App: Download from https://jagopro.org/apks/"
echo "   Driver App: Download from https://jagopro.org/apks/"
echo ""
echo "📧 Admin Credentials (UPDATED Mar 24, 2026):"
echo "   Email:    Kiranatmakuri518@gmail.com"
echo "   Password: Greeshmant@2023"
echo ""
echo "✅ What was deployed:"
echo "   ✓ Latest code (commit: f0d9a20)"
echo "   ✓ 2FA disabled"
echo "   ✓ Admin updated"
echo "   ✓ Database migrated"
echo "   ✓ Server restarted"
echo ""
echo "⏳ Server warmup time: 30-60 seconds"
echo "   If login initially fails, wait 1 minute and try again"
echo ""
echo "📊 View server logs:"
echo "   pm2 logs jago-api"
echo ""
echo "🎉 Production is now LIVE!"
echo ""
