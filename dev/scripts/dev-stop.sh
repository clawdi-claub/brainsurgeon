#!/bin/bash
# dev-stop.sh — Stop BrainSurgeon development environment

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEV_DIR="$(dirname "$SCRIPT_DIR")"

echo "🛑 Stopping BrainSurgeon Dev Environment..."
echo ""

cd "$DEV_DIR"

if [ -f "docker-compose.dev.yml" ]; then
    docker-compose -f docker-compose.dev.yml down
    echo ""
    echo "✅ Dev environment stopped"
else
    echo "⚠️  docker-compose.dev.yml not found"
    echo "   Attempting to stop containers by name..."
    docker stop openclaw-gateway-dev brainsurgeon-api-dev brainsurgeon-web-dev 2>/dev/null || true
    docker rm openclaw-gateway-dev brainsurgeon-api-dev brainsurgeon-web-dev 2>/dev/null || true
    echo "✅ Containers stopped (if they were running)"
fi

echo ""
