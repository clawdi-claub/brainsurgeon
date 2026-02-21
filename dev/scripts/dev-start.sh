#!/bin/bash
# dev-start.sh — Start BrainSurgeon development environment

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEV_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_DIR="$(dirname "$DEV_DIR")"

echo "🧠 BrainSurgeon Dev Environment"
echo "================================"
echo ""

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
    echo "❌ Docker is not running. Please start Docker first."
    exit 1
fi

# Create data directories if they don't exist
mkdir -p "$DEV_DIR/data/agents"
mkdir -p "$DEV_DIR/data/extracted"
mkdir -p "$DEV_DIR/logs"
mkdir -p "$DEV_DIR/config"

echo "📁 Ensured data directories exist"

# Check if dev config exists, create from template if not
if [ ! -f "$DEV_DIR/config/openclaw.dev.json" ]; then
    echo "⚙️  Creating default dev config..."
    cat > "$DEV_DIR/config/openclaw.dev.json" << 'EOF'
{
  "gateway": {
    "port": 18789,
    "host": "0.0.0.0"
  },
  "canvas": {
    "port": 18793,
    "host": "0.0.0.0"
  },
  "agents": {
    "directory": "/app/agents"
  },
  "plugins": {
    "enabled": true,
    "entries": {
      "brainsurgeon": {
        "path": "/app/extensions/brainsurgeon",
        "enabled": true,
        "config": {
          "agentsDir": "/app/agents",
          "apiUrl": "http://brainsurgeon-api-dev:8000",
          "enableAutoPrune": true,
          "autoPruneThreshold": 3,
          "busDbPath": "/data/bus.db"
        }
      }
    }
  },
  "logging": {
    "level": "debug",
    "file": "/app/logs/openclaw.log"
  },
  "features": {
    "extractedContent": {
      "directory": "/app/extracted"
    }
  }
}
EOF
fi

# Check if docker-compose.dev.yml exists
if [ ! -f "$DEV_DIR/docker-compose.dev.yml" ]; then
    echo "❌ docker-compose.dev.yml not found in $DEV_DIR"
    echo "   Please create it first (see DEV-ENV-SPEC.md)"
    exit 1
fi

echo "🐳 Building and starting dev environment..."
echo ""

cd "$DEV_DIR"
docker-compose -f docker-compose.dev.yml up --build -d

echo ""
echo "⏳ Waiting for services to be healthy..."
echo ""

# Wait for gateway
for i in {1..30}; do
    if curl -s http://localhost:28789/health > /dev/null 2>&1; then
        echo "✅ Gateway is healthy"
        break
    fi
    if [ $i -eq 30 ]; then
        echo "⚠️  Gateway health check timed out (may still be starting)"
    fi
    sleep 1
done

# Wait for BrainSurgeon API
for i in {1..30}; do
    if curl -s http://localhost:28000/api/agents > /dev/null 2>&1; then
        echo "✅ BrainSurgeon API is healthy"
        break
    fi
    if [ $i -eq 30 ]; then
        echo "⚠️  BrainSurgeon API health check timed out (may still be starting)"
    fi
    sleep 1
done

echo ""
echo "🚀 Dev Environment Ready!"
echo "========================="
echo ""
echo "📍 URLs:"
echo "   Gateway:    http://localhost:28789"
echo "   Canvas:     http://localhost:28793"
echo "   BrainSurgeon API:  http://localhost:28000"
echo "   BrainSurgeon Web:  http://localhost:28080"
echo ""
echo "🔧 Useful commands:"
echo "   View logs:  docker-compose -f docker-compose.dev.yml logs -f"
echo "   Stop:       $SCRIPT_DIR/dev-stop.sh"
echo "   Reset:      $SCRIPT_DIR/dev-reset.sh"
echo ""
echo "⚠️  This environment is isolated from production."
echo "   Production gateway runs on ports 18789/18793"
echo "   Dev gateway runs on ports 28789/28793"
echo ""
