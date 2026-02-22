# BrainSurgeon — Extension Restoration with purge_control Tool

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work proceeds.

Reference: This document follows the ExecPlan format defined in `~/.openclaw/workspace-shared/PLANS.md`.

## Purpose / Big Picture

BrainSurgeon is a session management system that extracts large content from OpenClaw sessions to keep context windows lean. After this plan completes, OpenClaw agents will be able to control extraction via a unified `purge_control` tool with three actions: `get_context`, `restore`, and `set_extractable`. A user will be able to call `purge_control` from any session to view extraction status, restore previously extracted content, or mark entries to never be extracted.

Currently, the old `restore_remote` tool is deployed but broken. The new `purge_control` specification exists in documentation but has not been implemented in the extension or API.

## Progress

- [x] (2026-02-18) TypeScript API fully operational with all endpoints
- [x] (2026-02-19) Smart Pruning system implemented with configurable triggers
- [x] (2026-02-20) Extraction storage, trash integration, and lock system working
- [x] (2026-02-20) SKILL.md documents purge_control tool with three actions
- [x] (2026-02-21) Extension audited — 8 critical mismatches identified
- [x] (2026-02-22) Fixed extension to implement purge_control tool (not restore_remote)
- [x] (2026-02-22) Fixed file extension mismatch (.jsonl → .json)
- [x] (2026-02-22) Fixed API endpoint resolution (sessionKey → sessionId)
- [x] (2026-02-22) Fixed config service tests (all 164 tests passing)
- [x] (2026-02-22) Extension deployed and loading successfully
- [ ] End-to-end test: extract → restore cycle via purge_control

## Surprises & Discoveries

- Observation: Extension is currently loaded and registered according to OpenClaw logs, but the `restore_remote` tool implementation is broken
  Evidence: Journal shows `14:37:42 [plugins] BrainSurgeon plugin registered successfully` — but the extension code has critical bugs

- Observation: The specification documents `purge_control` tool, but the deployed extension still implements old `restore_remote` tool
  Evidence: `~/.openclaw/extensions/brainsurgeon/index.ts` line 175 defines `restore_remote` tool, not `purge_control`

- Observation: Extension config points to `localhost:8000` but API is on Docker network at `172.25.0.2:8000`
  Evidence: Docker container `brainsurgeon` runs on network `nginx-subnet` with IP `172.25.0.2`, not accessible via localhost

- Observation: API cannot see agents due to AGENTS_DIR mismatch
  Evidence: Container env has `AGENTS_DIR=/data/openclaw/agents` but volume mounts `~/.openclaw:/openclaw` — `/data` path does not exist in container

- Observation: Extension looks for `.jsonl` files but API stores `.json`
  Evidence: Line 111 in `extensions/brainsurgeon/index.ts`: `${entryId}.jsonl` vs API storage using `.json` extension

## Decision Log

- Decision: Replace `restore_remote` with `purge_control` tool following the SKILL.md specification
  Rationale: SKILL.md is the authoritative interface specification; `purge_control` with three actions is more flexible than single-purpose `restore_remote`
  Date/Author: 2026-02-21 / crix-claub

- Decision: Extension will remain disabled until all fixes are complete and tested locally
  Rationale: Previous attempts crashed the gateway; no partial fixes deployed to production
  Date/Author: 2026-02-21 / crix-claub

- Decision: Fix extension to call API endpoints rather than direct file operations
  Rationale: The extension should use the REST API for all operations; direct file operations bypass Business logic and locking
  Date/Author: 2026-02-21 / crix-claub

- Decision: API must accept sessionKey and resolve to sessionId internally
  Rationale: Extension receives sessionKey (e.g., `agent:crix-claub:direct:123`) but API needs file-based session ID; resolution should happen in one place
  Date/Author: 2026-02-21 / crix-claub

- Decision: Remove `extension.yaml` entirely
  Rationale: OpenClaw Plugin SDK only reads `openclaw.plugin.json` and `package.json`; extension.yaml contains invalid legacy format
  Date/Author: 2026-02-21 / crix-claub

- Decision: Change extension to use `http://172.25.0.2:8000` or nginx proxy, not `localhost:8000`
  Rationale: API runs in Docker container on nginx-subnet; localhost from host context is wrong
  Date/Author: 2026-02-21 / crix-claub

- Decision: Fix config service tests to match actual ConfigResponse structure
  Rationale: Tests were written expecting nested `.config` property but service returns ConfigResponse directly; fixed tests and added trigger type validation
  Date/Author: 2026-02-22 / crix-claub

## Outcomes & Retrospective

(Pending completion of extension restoration)

## Context and Orientation

BrainSurgeon is a session management system with three components:

1. **TypeScript API** — A REST API server (port 8000 on Docker network `nginx-subnet` at `172.25.0.2`) that manages session pruning, extraction, and restoration. Located at `~/projects/brainsurgeon/ts-api/`. Uses Hono web framework. The API reads agents from `AGENTS_DIR` environment variable.

2. **WebUI** — A static HTML/JS frontend served at brain.lpc.one via nginx proxy. Located at `~/projects/brainsurgeon/web/`. Calls the TypeScript API through nginx.

3. **OpenClaw Extension** — A plugin for OpenClaw that provides session management tools. Located at `~/projects/brainsurgeon/extensions/brainsurgeon/`. The extension is TypeScript source code that OpenClaw loads directly.

### Current Extension Files

- `~/.openclaw/extensions/brainsurgeon/index.ts` — Main plugin code (TypeScript)
- `~/.openclaw/extensions/brainsurgeon/openclaw.plugin.json` — Plugin metadata
- `~/.openclaw/extensions/brainsurgeon/package.json` — NPM package metadata
- `~/.openclaw/extensions/brainsurgeon/extension.yaml` — LEGACY file, should be deleted

### Key Configuration Values in openclaw.json

```json
{
  "plugins": {
    "entries": {
      "brainsurgeon": {
        "enabled": true,
        "config": {
          "agentsDir": "/home/openclaw/.openclaw/agents",
          "apiUrl": "http://localhost:8000",
          "enableAutoPrune": true,
          "autoPruneThreshold": 3,
          "keepRestoreRemoteCalls": false,
          "busDbPath": "/home/openclaw/.openclaw/brainsurgeon/bus.db"
        }
      }
    }
  }
}
```

### The purge_control Tool Specification (from SKILL.md)

The skill documentation specifies a unified tool with three actions:

```bash
# Check context stats
purge_control get_context --agent crix-claub --session direct:123

# Restore extracted content
purge_control restore msg-abc123 --agent crix-claub --session direct:123

# Mark content as never-extractable
purge_control set_extractable msg-abc123 false --agent crix-claub --session direct:123

# Set custom keep window
purge_control set_extractable msg-abc123 10 --agent crix-claub --session direct:123
```

As an OpenClaw tool, this translates to:

```json
{
  "name": "purge_control",
  "parameters": {
    "action": "get_context" | "restore" | "set_extractable",
    "agent": "crix-claub",
    "session": "direct:123",
    "entry": "msg-abc123",
    "value": false  // for set_extractable
  }
}
```

### Current vs Specified State

| Aspect | Current (Deployed) | Specified (SKILL.md) | Status |
|--------|-------------------|----------------------|--------|
| Tool name | `restore_remote` | `purge_control` | ❌ Mismatch |
| Actions | 1 (restore only) | 3 (get_context, restore, set_extractable) | ❌ Missing |
| API connectivity | Broken (localhost:8000) | Should work via Docker network | ❌ Broken |
| Session ID handling | sessionKey passed raw | Should be resolved by API | ⚠️ Needs fix |
| File extension | `.jsonl` | `.json` | ❌ Mismatch |
| Auto-prune hooks | Call wrong endpoints | Should call correct API | ❌ Broken |

## Analysis: What Must Be Updated

### Gap 1: Extension Tool Implementation

### Gap 1.5: Missing API Endpoint Specifications

The `purge_control` tool requires three API endpoints, but only one exists:

| Action | Required Endpoint | Status | Notes |
|--------|-------------------|--------|-------|
| `get_context` | `GET /sessions/:agent/:id/context` | ❌ Missing | Returns context stats, extracted entries, session metadata |
| `restore` | `POST /sessions/:agent/:id/entries/:entryId/restore` | ✅ Exists | Already implemented in routes.ts (line ~280) |
| `set_extractable` | `PUT /sessions/:agent/:id/entries/:entryId/meta` | ❌ Missing | Updates entry metadata (specifically `_extractable`) |

**Required New Endpoints:**

#### GET /sessions/:agent/:id/context

Returns context statistics and extraction status for a session:

```typescript
// Response
{
  sessionId: string;
  agentId: string;
  totalEntries: number;
  extractedEntries: number;
  extractedIds: string[];
  extractableEntries: number;  // entries not marked never-extract
  sizeBytes: number;
  extractedSizeBytes: number;
  lastExtractedAt?: string;
  entries: Array<{
    index: number;
    id: string;
    type: string;
    extractable: boolean | number;
    extracted: boolean;
    sizeBytes: number;
  }>;
}
```

#### PUT /sessions/:agent/:id/entries/:entryId/meta

Updates metadata fields on a specific entry:

```typescript
// Request body
{
  _extractable?: boolean | number;  // true/false or keep window size
  [key: string]: any;  // extensible for other metadata
}

// Response
{
  updated: true;
  entryId: string;
  fields: string[];  // which fields were updated
  previous: {        // previous values
    _extractable?: boolean | number;
  };
}
```

**Additional Requirement: SessionKey Resolution**

All endpoints must accept an optional `?sessionKey=` query parameter:
- Extension receives `sessionKey` (e.g., `agent:crix-claub:direct:123`)
- API must resolve this to `agentId` + `sessionId` internally
- Resolution logic: parse `agent:{agentId}:{kind}:{label}` → find matching session file

**Example:**
```
GET /sessions/_/test-session/context?sessionKey=agent:crix-claub:direct:123
```

The API should:
1. Check if `sessionKey` param exists
2. If yes, resolve to actual `agentId`/`sessionId` 
3. If resolution fails, return 404 with helpful error

### Gap 1: Extension Tool Implementation

The extension currently implements `restore_remote` as a single-purpose tool. It must be replaced with `purge_control` supporting three actions.

**Current code (index.ts lines 175-230):**
```typescript
api.registerTool(
  (ctx: any) => {
    if (!ctx?.agentId) return null;
    return {
      name: 'restore_remote',
      description: 'Restore extracted content...',
      parameters: { session, entry, keys },
      async execute(...) { ... }
    };
  },
  { name: 'restore_remote' }
);
```

**Required:purge_control tool with action dispatch**
```typescript
api.registerTool(
  (ctx: any) => {
    if (!ctx?.agentId) return null;
    return {
      name: 'purge_control',
      description: 'Control BrainSurgeon extraction: get_context, restore, set_extractable',
      parameters: {
        action: { enum: ['get_context', 'restore', 'set_extractable'] },
        agent: { type: 'string' },
        session: { type: 'string' },
        entry: { type: 'string' },
        keys: { type: 'string' },
        value: { type: 'boolean|integer' }  // for set_extractable
      },
      async execute(...) { 
        switch(params.action) { ... }
      }
    };
  },
  { name: 'purge_control' }
);
```

### Gap 2: File Extension Mismatch

**Line 111 in index.ts:**
```typescript
const extractedPath = path.join(sessionsDir, 'extracted', sessionId,`${entryId}.jsonl`);
```

**Must change to:**
```typescript
const extractedPath = path.join(sessionsDir, 'extracted', sessionId, `${entryId}.json`);
```

### Gap 3: API URL Configuration

The extension config uses `localhost:8000` but the API is accessible at `172.25.0.2:8000` (Docker nginx-subnet) or through nginx at `brain.lpc.one/api/`.

**Options:**
1. Change config to `http://172.25.0.2:8000` (direct Docker network)
2. Change config to `https://brain.lpc.one/api` (via nginx proxy with SSL)
3. Expose API port 8000 on localhost

**Recommendation:** Option 1 for internal communication (no nginx/auth overhead), Option 3 for flexibility.

### Gap 4: API Session Resolution

The API currently only accepts file-based session IDs. The extension receives `sessionKey` format (`agent:{agentId}:{kind}:{label}`) and cannot easily resolve this.

**Option A:** Modify API to accept sessionKey and resolve internally
**Option B:** Extension resolves sessionKey by scanning sessions directory (fragile)

**Recommendation:** Option A — add sessionKey support to API endpoints.

### Gap 5: API AGENTS_DIR Mismatch

The Docker container has wrong path. Fix in docker-compose or Dockerfile.

## Plan of Work

### Milestone 1: Extension purge_control Tool Implementation

**Goal:** Replace `restore_remote` with `purge_control` supporting all three actions.

**Files to modify:**
- `~/projects/brainsurgeon/extensions/brainsurgeon/index.ts`

**Changes:**

1. Rename tool from `restore_remote` to `purge_control`
2. Expand parameters to include `action` enum
3. Implement action dispatch:
   - `get_context`: Call API to get session status and extracted entries
   - `restore`: Call API restore endpoint (currently does direct file ops)
   - `set_extractable`: Call API to set `_extractable` field on entry
4. Fix file extension from `.jsonl` to `.json`

### Milestone 2: API Enhancements

**Goal:** Support sessionKey resolution and add purge_control endpoints.

**Files to modify:**
- `~/projects/brainsurgeon/ts-api/src/domains/session/api/routes.ts` — Add sessionKey resolution
- `~/projects/brainsurgeon/ts-api/src/domains/config/model/config.ts` — Verify config schema

**Changes:**

1. Add sessionKey parameter support to relevant endpoints
2. Implement sessionKey → sessionId resolution logic
3. Add endpoint for `set_extractable` action
4. Add endpoint for `get_context` action

### Milestone 3: Docker Configuration Fix

**Goal:** Fix AGENTS_DIR and API accessibility.

**Files to modify:**
- `~/projects/brainsurgeon/docker-compose.yml` or `~/projects/www-nginx/docker-compose.yml`

**Changes:**

1. Fix AGENTS_DIR environment variable to match volume mount
2. Optionally expose API port 8000 on localhost
3. Document correct apiUrl for extension config

### Milestone 4: Deploy and Verify

**Goal:** Deploy fixed extension and verify end-to-end functionality.

**Steps:**

1. Copy extension to test location and verify TypeScript compiles
2. Remove `extension.yaml` (legacy file)
3. Update `~/.openclaw/openclaw.json` with correct `apiUrl` (e.g., `http://172.25.0.2:8000`)
4. Deploy extension to `~/.openclaw/extensions/brainsurgeon/`
5. Restart OpenClaw gateway
6. Check logs for successful registration: `BrainSurgeon plugin registered successfully`
7. Verify `purge_control` tool appears in available tools
8. Test full cycle: extract → purge_control restore → verify content restored

## Concrete Steps

All commands assume working directory is `~/projects/brainsurgeon` unless specified.

### Step 1: Fix file extension in extension
```bash
sed -i 's/\${entryId}\.jsonl/${entryId}.json/' extensions/brainsurgeon/index.ts
```

### Step 2: Delete legacy extension.yaml
```bash
rm extensions/brainsurgeon/extension.yaml
```

### Step 3: Update extension config in openclaw.json
Edit `~/.openclaw/openclaw.json` and change:
```json
{
  "plugins": {
    "entries": {
      "brainsurgeon": {
        "config": {
          "apiUrl": "http://172.25.0.2:8000"
        }
      }
    }
  }
}
```

### Step 4: Deploy extension
```bash
rm -rf ~/.openclaw/extensions/brainsurgeon
cp -r ~/projects/brainsurgeon/extensions/brainsurgeon ~/.openclaw/extensions/
openclaw gateway restart
sleep 10
```

### Step 5: Verify logs
```bash
openclaw logs | grep -i brainsurgeon
```

Expected output:
```
[plugins] purge_control tool registered
[plugins] BrainSurgeon plugin registered successfully
```

### Step 6: Test extraction and restore
1. Create a session with large content (>500 chars)
2. Trigger smart prune (via WebUI or wait for auto-prune)
3. Verify `[[extracted-${entryId}]]` placeholder appears
4. Call `purge_control` tool with action `restore`
5. Verify content is restored

## Validation and Acceptance

Extension is working when:
1. OpenClaw logs show: `BrainSurgeon plugin registered successfully` with no errors
2. `purge_control` tool appears in available tools
3. Calling `purge_control get_context` returns session status and extracted entries
4. Calling `purge_control restore` finds and restores extracted content
5. Calling `purge_control set_extractable` modifies entry metadata
6. No crashes in `journalctl` when searching for openclaw

## Idempotence and Recovery

- Extension directory can be wiped and recopied safely
- If extension crashes OpenClaw: remove from allow list, restart gateway, fix code, redeploy
- Keep `~/projects/brainsurgeon/extensions/brainsurgeon/` as source of truth

## Artifacts and Notes

**Historical errors from crashed extension (for reference):**
```
TypeError: Cannot read properties of undefined (reading 'info')
    at activate (/.../index.ts:367:11)
```

**Extension loading requirements:**
- `openclaw.plugin.json` with valid JSON and `configSchema`
- `package.json` with `"type": "module"` for ESM
- Main code exports default with `register(api)` function
- No `extension.yaml` (legacy format)

## Interfaces and Dependencies

The extension implements this interface for OpenClaw:

```typescript
interface OpenClawPluginDefinition {
  id: string;
  name: string;
  description: string;
  version: string;
  register(api: OpenClawPluginApi): void | Promise<void>;
}
```

The API parameter provides:

```typescript
interface OpenClawPluginApi {
  logger: { 
    info(msg: string): void; 
    error(msg: string): void; 
    debug?(msg: string): void 
  };
  pluginConfig?: Record<string, any>;
  registerTool(factory: (ctx: any) => ToolDefinition | null): void;
  on(hookName: string, handler: Function): void;
  resolvePath(input: string): string;
}
```

---

**Document revision:** Initial creation 2026-02-21 14:45Z  
**Updated:** 2026-02-21 to reflect purge_control specification  
**Replaces:** All prior planning documents consolidated
