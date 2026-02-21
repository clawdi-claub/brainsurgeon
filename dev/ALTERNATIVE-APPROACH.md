# BrainSurgeon Dev Environment — Alternative Approach

**Date:** 2026-02-21  
**Status:** In Progress

## Problem

OpenClaw runs natively on this host (not in Docker), making a fully isolated dev gateway challenging.

## Alternative Approaches

### Option A: API + WebUI Only (Simplest)
Run only the BrainSurgeon API and WebUI in Docker, test against production gateway with monitoring.

**Pros:** Quick to set up, tests the UI and API
**Cons:** Extension runs against prod gateway (risk)

### Option B: Second Gateway Instance (If Supported)
Run a second OpenClaw gateway on different ports (28789/28793).

**Pros:** True isolation
**Cons:** Need to verify OpenClaw supports multiple instances

### Option C: DMZ Server (When Ready)
Wait for DMZ server and do dev there.

**Pros:** Full isolation, production-safe
**Cons:** Not available yet

## Current Status

**Completed:**
- ✅ docker-compose.dev.yml (API + WebUI services)
- ✅ Dev helper scripts
- ✅ Test data generator
- ✅ API Dockerfile.dev (hot-reload)
- ✅ Nginx config for dev

**Blocked:**
- ⚠️ Gateway Dockerfile — needs native OpenClaw install or second instance support

## Next Steps

1. **Try Option A first** — Start API+WebUI, test manually
2. **Crix to handle kb-140** — Extension crash fix in production gateway with monitoring
3. **Re-evaluate** — After kb-140 fixed, decide if dev gateway needed

## Quick Start (API + WebUI Only)

```bash
cd ~/projects/brainsurgeon/dev

# Generate test data first
./scripts/generate-test-data.sh

# Start just the API and WebUI (not gateway)
docker-compose -f docker-compose.dev.yml up -d brainsurgeon-api-dev brainsurgeon-web-dev

# Test
curl http://localhost:28000/api/agents
open http://localhost:28080
```
