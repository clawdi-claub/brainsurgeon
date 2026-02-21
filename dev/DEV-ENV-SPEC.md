# BrainSurgeon Dev Environment Specification

**Status:** Draft
**Purpose:** Isolated testing environment for BrainSurgeon extension development without risking production OpenClaw gateway.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Host Machine                             │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Dev Environment (Docker Compose)                       │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │   │
│  │  │  OpenClaw    │  │ BrainSurgeon │  │  BrainSurgeon│  │   │
│  │  │  Gateway     │──│  Extension   │──│  API/WebUI   │  │   │
│  │  │  (dev)       │  │  (linked)    │  │  (dev build) │  │   │
│  │  └──────────────┘  └──────────────┘  └──────────────┘  │   │
│  │         │                   │                 │         │   │
│  │         └───────────────────┴─────────────────┘         │   │
│  │                        │                                │   │
│  │              Shared Volume: dev-data/                   │   │
│  └─────────────────────────────────────────────────────────┘   │
│                              │                                  │
│                         ┌────┴────┐                            │
│                         │ Test DB │ (isolated from prod)       │
│                         └─────────┘                            │
└─────────────────────────────────────────────────────────────────┘
```

---

## Goals

1. **Complete Isolation** - Dev gateway runs on separate ports/config from production
2. **Fast Feedback Loop** - Extension code can be hot-reloaded without full restart
3. **Safe Testing** - Crashes in dev don't affect production agents
4. **Realistic Data** - Can mirror production sessions for realistic testing
5. **Easy Reset** - One command to wipe dev state and start fresh

---

## File Structure

```
~/projects/brainsurgeon/dev/
├── docker-compose.dev.yml      # Dev environment orchestration
├── Dockerfile.gateway          # OpenClaw gateway dev build
├── Dockerfile.api              # BrainSurgeon API dev build
├── config/
│   ├── openclaw.dev.json       # Dev gateway config
│   └── nginx.dev.conf          # Dev reverse proxy
├── data/                       # Isolated data volume
│   ├── agents/                 # Dev agent sessions
│   ├── extracted/              # Dev extractions
│   └── bus.db                  # Dev message bus
├── logs/                       # Dev logs
└── scripts/
    ├── dev-start.sh            # Start dev environment
    ├── dev-stop.sh             # Stop dev environment
    ├── dev-reset.sh            # Reset to clean state
    └── sync-prod-data.sh       # Copy prod data for testing (safe read-only)
```

---

## Port Mapping

| Service | Production | Development |
|---------|-----------|-------------|
| OpenClaw Gateway | 18789 | **28789** |
| OpenClaw Canvas | 18793 | **28793** |
| BrainSurgeon API | 8000 | **28000** |
| BrainSurgeon WebUI | 80/443 | **28080** |
| Redis (if needed) | 6379 | **26379** |

---

## Docker Compose Configuration

```yaml
# docker-compose.dev.yml
version: '3.8'

services:
  # OpenClaw Gateway (Development Instance)
  gateway-dev:
    build:
      context: ./Dockerfile.gateway
    container_name: openclaw-gateway-dev
    ports:
      - "28789:18789"  # Gateway API
      - "28793:18793"  # Canvas
    volumes:
      - ./config/openclaw.dev.json:/app/config.json:ro
      - ./data/agents:/app/agents
      - ./data/extracted:/app/extracted
      - ./logs:/app/logs
      - ../extensions:/app/extensions:ro  # Mount extension source for hot-reload
    environment:
      - OPENCLAW_CONFIG=/app/config.json
      - LOG_LEVEL=debug
      - NODE_ENV=development
    networks:
      - brainsurgeon-dev
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:18789/health"]
      interval: 10s
      timeout: 5s
      retries: 3
      start_period: 30s

  # BrainSurgeon API Server (Development Build)
  brainsurgeon-api-dev:
    build:
      context: ../ts-api
      dockerfile: Dockerfile.dev  # Dev Dockerfile with nodemon
    container_name: brainsurgeon-api-dev
    ports:
      - "28000:8000"
    volumes:
      - ../ts-api/src:/app/src:ro  # Hot-reload source
      - ./data/agents:/data/agents:ro
      - ./data/extracted:/data/extracted
      - ./data:/data  # For bus.db
    environment:
      - PORT=8000
      - AGENTS_DIR=/data/agents
      - DATA_DIR=/data
      - LOG_LEVEL=debug
      - BRAINSURGEON_API_KEYS=dev_key_insecure_do_not_use_in_prod
      - GATEWAY_URL=http://gateway-dev:18789
    networks:
      - brainsurgeon-dev
    depends_on:
      gateway-dev:
        condition: service_healthy

  # BrainSurgeon WebUI (Static + Proxy)
  brainsurgeon-web-dev:
    image: nginx:alpine
    container_name: brainsurgeon-web-dev
    ports:
      - "28080:80"
    volumes:
      - ../web:/usr/share/nginx/html:ro
      - ./config/nginx.dev.conf:/etc/nginx/conf.d/default.conf:ro
    networks:
      - brainsurgeon-dev
    depends_on:
      - brainsurgeon-api-dev

networks:
  brainsurgeon-dev:
    driver: bridge
```

---

## OpenClaw Dev Config

```json
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
```

---

## Known Issues to Address

Based on backlog items kb-140 through kb-146:

### 🔥 kb-140: Extension Crashes Gateway
**Hypothesis:** Extension throws unhandled exception during plugin hook execution, taking down gateway process.

**Dev Test:**
1. Introduce intentional errors in extension hooks
2. Verify gateway catches and logs without crashing
3. Ensure extension can be disabled without restart

**Fix Strategy:**
- Add try/catch wrappers around all plugin hooks
- Implement graceful degradation (log error, skip hook)
- Add hook timeout (kill hook after 5s, don't block gateway)

---

### 🔥 kb-141: Smart Pruning Corrupts Session Entries
**Hypothesis:** `id`/`parentId` fields being extracted when they shouldn't be, breaking session structure.

**Dev Test:**
1. Create sessions with complex entry structures
2. Trigger smart prune
3. Verify `id`/`parentId` remain in session file
4. Verify extracted files don't contain structural fields

**Fix Strategy:**
- Add explicit whitelist/blacklist for extraction fields
- Never extract: `id`, `parentId`, `__id`, `sessionId`, `timestamp`
- Add validation step after extraction to verify session integrity

---

### 🔥 kb-146: smart-purge-control Skill Broken
**Hypothesis:** Skill references old API or tool name mismatch.

**Dev Test:**
1. Load smart-purge-control skill
2. Verify tool registration works
3. Test skill interactions with BrainSurgeon

---

### kb-143: extracted/ Dir Permissions
**Dev Test:**
1. Run dev environment with various umask settings
2. Verify BrainSurgeon can read/write extracted files
3. Verify restore_remote can access files

---

### kb-144: Auth Detection Broken in UI
**Dev Test:**
1. Access web UI with/without API key
2. Verify readonly mode detection
3. Test CORS behavior

---

## Development Workflow

### Starting Dev Environment

```bash
cd ~/projects/brainsurgeon/dev
./scripts/dev-start.sh
```

This will:
1. Build dev Docker images
2. Create isolated data directories
3. Start services with health checks
4. Display URLs and test commands

### Testing Extension Changes

```bash
# Edit extension code (hot-reload active)
vim ~/.openclaw/extensions/brainsurgeon/index.ts

# Trigger test action
curl http://localhost:28000/api/sessions

# Check gateway logs for errors
docker logs -f openclaw-gateway-dev
```

### Safe Production Data Testing

```bash
# Copy sanitized prod data for realistic testing
./scripts/sync-prod-data.sh --anonymize

# This copies session structure but removes:
# - Actual message content (replaced with lorem ipsum)
# - User identifiers
# - Sensitive tool results
```

### Resetting Dev Environment

```bash
./scripts/dev-reset.sh
```

Wipes all dev data and restarts fresh. Useful when:
- Session corruption occurs
- Testing from clean slate
- Database schema changes

---

## Smoke test: purge_control (end-to-end)

This verifies the **BrainSurgeon OpenClaw extension** loads correctly and can restore extracted content back into a session file.

### 1) Create a dummy session entry + extracted payload

```bash
AGENTS=~/projects/brainsurgeon/dev/data/agents
AG=test-agent-1
SID=dev-restore-smoke
EID=e1

mkdir -p "$AGENTS/$AG/sessions/extracted/$SID"

cat > "$AGENTS/$AG/sessions/$SID.jsonl" <<'EOF'
{"__id":"e1","id":"e1","type":"assistant_message","payload":{"answer":"[[extracted]]","notes":"keep"}}
EOF

cat > "$AGENTS/$AG/sessions/extracted/$SID/$EID.jsonl" <<'EOF'
{"payload":{"answer":"RESTORED_OK"}}
EOF
```

### 2) Invoke the tool through the Gateway HTTP API

```bash
curl -sS http://127.0.0.1:28789/tools/invoke \
  -H 'Authorization: Bearer dev_gateway_token_please_change' \
  -H 'Content-Type: application/json' \
  -d '{
    "tool":"purge_control",
    "sessionKey":"agent:test-agent-1:main",
    "args": {"action":"restore","session":"dev-restore-smoke","entry":"e1"}
  }'
```

Expected: `ok:true` and message like "Restored 1 keys… payload.answer".

### 3) Verify session file got patched

```bash
cat "$AGENTS/$AG/sessions/$SID.jsonl"
```

Expected: `payload.answer` is no longer a placeholder and `_restored`/`__restored_keys` are present.

---

## Test Checklist Before Production Deploy

- [ ] Extension loads without crashing gateway
- [ ] Hook errors are caught and logged gracefully
- [ ] Smart prune preserves session structure (id/parentId)
- [ ] Extracted files have correct permissions
- [ ] purge_control tool works end-to-end
- [ ] WebUI loads and displays sessions
- [ ] Auth detection works in UI
- [ ] Gateway restart doesn't lose extension state
- [ ] Extension can be disabled/enabled without gateway restart
- [ ] No memory leaks after 100+ session operations

---

## Next Steps

1. **Crix:** Create dev Dockerfiles and docker-compose.dev.yml
2. **Crix:** Implement try/catch wrappers in extension hooks (kb-140)
3. **Clawdi:** Create test data generator scripts
4. **Both:** Run through test checklist
5. **Both:** Deploy to brain.lpc.one only after all tests pass

---

## Appendix: Debug Commands

```bash
# View all dev logs
docker-compose -f docker-compose.dev.yml logs -f

# Gateway specific
docker logs -f openclaw-gateway-dev

# API specific
docker logs -f brainsurgeon-api-dev

# Test gateway health
curl http://localhost:28789/health

# Test BrainSurgeon API
curl http://localhost:28000/api/agents

# Access dev web UI
open http://localhost:28080

# Shell into dev gateway
docker exec -it openclaw-gateway-dev sh

# Shell into dev API
docker exec -it brainsurgeon-api-dev sh
```
