#!/bin/bash
# dev-reset.sh — Reset BrainSurgeon dev environment to clean state

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEV_DIR="$(dirname "$SCRIPT_DIR")"

echo "🔄 Resetting BrainSurgeon Dev Environment"
echo "========================================="
echo ""
echo "⚠️  WARNING: This will delete all dev data!"
echo "   - Dev agent sessions"
echo "   - Dev extracted files"
echo "   - Dev logs"
echo ""

read -p "Are you sure? Type 'yes' to continue: " confirm
if [ "$confirm" != "yes" ]; then
    echo "❌ Reset cancelled"
    exit 0
fi

echo ""
echo "🛑 Stopping containers..."
cd "$DEV_DIR"
docker compose -f docker-compose.dev.yml down 2>/dev/null || true

echo ""
echo "🗑️  Removing dev data..."
rm -rf "$DEV_DIR/data/agents"/*
rm -rf "$DEV_DIR/data/extracted"/*
rm -rf "$DEV_DIR/logs"/*
rm -f "$DEV_DIR/data/bus.db"

echo ""
echo "🏗️  Rebuilding containers..."
docker compose -f docker-compose.dev.yml build --no-cache

echo ""
echo "🚀 Starting fresh environment..."
docker compose -f docker-compose.dev.yml up -d

echo ""
echo "⏳ Waiting for services..."
sleep 5

echo ""
echo "✅ Dev environment reset complete!"
echo ""
echo "📍 URLs:"
echo "   Gateway:    http://localhost:28789"
echo "   Canvas:     http://localhost:28793"
echo "   BrainSurgeon API:  http://localhost:28000"
echo "   BrainSurgeon Web:  http://localhost:28080"
echo ""
