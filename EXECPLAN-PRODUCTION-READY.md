# BrainSurgeon Production Readiness ExecPlan

**Status:** Draft  
**Owner:** crix-claub  
**Created:** 2026-02-21  
**Priority:** Critical — Extension disabled pending fixes

---

## Executive Summary

The BrainSurgeon extension was disabled due to multiple critical inconsistencies between the extension code, API endpoints, configuration schema, and OpenClaw Plugin SDK. This plan documents every identified issue and provides step-by-step remediation.

**Current State:**
- ✅ TypeScript API (port 8000) — Operational
- ✅ WebUI (brain.lpc.one) — Operational  
- ✅ Docker deployment — Working
- ❌ OpenClaw Extension — DISABLED, broken
- ❌ Configuration mismatches throughout

---

## Critical Issues Found

### Issue 1: Extension API Endpoint Mismatches (CRITICAL)

**Problem:** Extension calls wrong API endpoints

| Extension Calls | Actual API Endpoint | Status |
|----------------|---------------------|--------|
| `POST /prune` | `POST /sessions/:agent/:id/prune` | ❌ WRONG |
| `POST /compact` | `POST /sessions/:agent/:id/compact` | ❌ WRONG |

**Files Affected:**
- `extensions/brainsurgeon/index.ts` lines 267-278 (callBrainSurgeonApi calls)

**Fix Required:**
```typescript
// WRONG (current):
await callBrainSurgeonApi(cfg.apiUrl, 'POST', '/prune', { ... })
await callBrainSurgeonApi(cfg.apiUrl, 'POST', '/compact', { ... })

// CORRECT:
await callBrainSurgeonApi(cfg.apiUrl, 'POST', `/sessions/${agentId}/${sessionId}/prune`, { ... })
await callBrainSurgeonApi(cfg.apiUrl, 'POST', `/sessions/${agentId}/${sessionId}/compact`, { ... })
```

---

### Issue 2: Extension File Extension Mismatch (CRITICAL)

**Problem:** Extension looks for `.jsonl` files, API stores `.json` files

**Extension Code (index.ts:111):**
```typescript
const extractedPath = path.join(sessionsDir, 'extracted', sessionId, `${entryId}.jsonl`);
                                                                             //^^^^ WRONG
```

**API Storage (ts-api/src/domains/prune/extraction/extraction-storage.ts:50):**
```typescript
return join(this.extractedDir(agentId, sessionId), `${entryId}.json`);
                                                                    //^^^^ CORRECT
```

**Impact:** Extension can never find extracted files — restore functionality completely broken.

**Fix Required:**
```typescript
// Line 111: Change .jsonl to .json
const extractedPath = path.join(sessionsDir, 'extracted', sessionId, `${entryId}.json`);
```

---

### Issue 3: Extension.yaml Outdated / Invalid (CRITICAL)

**Problem:** `extension.yaml` references non-existent OpenClaw extension API

**Current extension.yaml:**
```yaml
entry_points:
  activate: ./index.ts      # ❌ OpenClaw doesn't use activate/deactivate
  deactivate: ./index.ts
permissions:
  tools:
    allow:
      - restore_remote      # ❌ Not how OpenClaw plugin tools work
dependencies:
  node_packages:
    - @sinclair/typebox    # ❌ Already removed dependency
```

**Analysis:** OpenClaw Plugin SDK uses `register(api)` pattern, not activate/deactivate. The extension.yaml appears to be from a different plugin system entirely.

**Decision needed:** Is extension.yaml used at all? If OpenClaw only reads `openclaw.plugin.json` and `package.json`, delete this file. If it's used for documentation only, update it.

---

### Issue 4: Configuration Schema Mismatch Between Extension vs API

**Problem:** Extension config schema doesn't match what API expects

**Extension Expects (index.ts:33-42):**
```typescript
{
  agentsDir: string;
  apiUrl: string;
  enableAutoPrune: boolean;
  autoPruneThreshold: number;
  keepRestoreRemoteCalls: boolean;
  busDbPath: string;
}
```

**API Actually Has (ts-api/src/domains/config/model/config.ts):**
```typescript
{
  enabled: boolean;
  trigger_types: TriggerType[];
  keep_recent: number;
  min_value_length: number;
  scan_interval_seconds: number;
  auto_cron: string;
  last_run_at: string | null;
  retention: string;
  retention_cron: string;
  last_retention_run_at: string | null;
  keep_restore_remote_calls: boolean;  // ✅ Only matching field
  keep_after_restore_seconds: number;
}
```

**Only 1/6 extension config fields exist in API:**
- ✅ `keepRestoreRemoteCalls` → `keep_restore_remote_calls`
- ❌ `agentsDir` — not in API (ENV var only)
- ❌ `apiUrl` — not in API (ENV var only)
- ❌ `enableAutoPrune` — not in API (API has `enabled`)
- ❌ `autoPruneThreshold` — not in API (API has `keep_recent`)
- ❌ `busDbPath` — not in API (ENV var only)

**Impact:** Extension reads from `api.pluginConfig` expecting fields that don't exist in the runtime config.

---

### Issue 5: OpenClaw Plugin SDK Pattern Violations (CRITICAL)

**Problem:** Extension uses wrong plugin API pattern

| Extension Uses | OpenClaw Actually Has | Status |
|----------------|----------------------|--------|
| `export default { register(api) {} }` | Correct ✅ | But implementation wrong |
| `api.log.info()` | `api.logger.info()` | ❌ WRONG |
| `api.config` | `api.pluginConfig` | ⚠️ Partially correct |
| `api.on('after_tool_call', ...)` | Correct ✅ | Hook name exists |
| `api.on('before_compaction', ...)` | Correct ✅ | Hook name exists |

The extension was rewritten to use correct patterns but needs verification.

---

### Issue 6: Tool Parameter Schema Mismatch (MEDIUM)

**Problem:** Tool parameter names in extension may not match what skill expects

**Extension Tool (index.ts:223-230):**
```typescript
parameters: {
  session: { type: 'string', description: 'Session ID...' },
  entry: { type: 'string', description: 'Entry ID...' },
  keys: { type: 'string', description: 'Comma-separated...' },
}
```

**API Restore Endpoint expects:**
```typescript
{
  keys?: string[];           // Array of strings, not comma-separated
  toolCallEntryId?: string;  // For redaction
}
```

The extension receives `keys` as a comma-separated string, but the API expects an array. The extension does the splitting (`params.keys?.split(',')`) which is correct, BUT it never passes `toolCallEntryId` to the API for redaction.

---

### Issue 7: Session Key Parsing (MEDIUM)

**Problem:** Extension attempts to parse sessionKey but doesn't use it correctly

**Current Code (index.ts:269-278):**
```typescript
// Extract session ID from session key (format: "agent:<agentId>:<kind>:<label>")
// The API needs the file-based session ID, not the key
await callBrainSurgeonApi(cfg.apiUrl, 'POST', '/prune', {
  agentId,
  sessionKey,  // ❌ API expects sessionId (file-based), not sessionKey
  threshold: cfg.autoPruneThreshold,
})
```

The API endpoint `/sessions/:agent/:id/prune` expects `id` to be the session file name (e.g., `416db9ef-41f6-427b-9ba0-9417c0d43f50.jsonl`), not the sessionKey.

**Session Key Format:** `agent:<agentId>:<kind>:<label>` (e.g., `agent:crix-claub:direct:6377178111`)

**Session File Format:** `{session-uuid}.jsonl` (e.g., `416db9ef-41f6-427b-9ba0-9417c0d43f50.jsonl`)

The extension needs to resolve sessionKey → sessionId, but there's no easy way to do this without scanning the sessions directory.

**Possible Solutions:**
1. Store sessionId→sessionKey mapping in bus DB
2. Have OpenClaw provide session file path in hook context
3. Change API to accept sessionKey and resolve internally

**Recommended:** Option 3 — modify API to resolve sessionKey internally using message bus or agent directory scan.

---

### Issue 8: Extracted File Path Mismatch (HIGH)

**Double-check:** Both extension and API agree on path structure?

**API Path:** `{agentsDir}/{agentId}/sessions/extracted/{sessionId}/{entryId}.json`

**Extension Path:** `{agentsDir}/{agentId}/sessions/extracted/{sessionId}/{entryId}.jsonl` (wrong extension)

**Fix:** Change `.jsonl` to `.json` in extension.

---

## Remediation Plan

### Phase 1: Extension Fixes (Critical Path)

**Task 1.1: Fix API endpoint calls**
- File: `extensions/brainsurgeon/index.ts`
- Change `/prune` → `/sessions/${agentId}/${sessionId}/prune`
- Change `/compact` → `/sessions/${agentId}/${sessionId}/compact`
- Status: 🔴 BLOCKED — Need sessionId resolution (see Issue 7)

**Task 1.2: Fix file extension**
- File: `extensions/brainsurgeon/index.ts:111`
- Change `.jsonl` → `.json`

**Task 1.3: Remove extension.yaml or update it**
- Delete or fix `extensions/brainsurgeon/extension.yaml`

**Task 1.4: Update config handling**
- Remove non-existent config fields from `getPluginConfig()`
- Read from ENV or hardcode defaults
- Only keep `keepRestoreRemoteCalls` which exists in API

**Task 1.5: Pass toolCallEntryId for redaction**
- When calling restore API, pass the tool call's entry ID
- Store it from execution context

### Phase 2: API Changes (Required for Extension)

**Task 2.1: Accept sessionKey in prune/compact endpoints**
- Add support for `sessionKey` param in `POST /sessions/:agent/:id/prune`
- If `sessionKey` provided, resolve to sessionId
- Allows extension to work without knowing file names

**Task 2.2: Add agentsDir to config response (optional)**
- Consider exposing `agentsDir` in `/config` for convenience
- Or keep as ENV var only

### Phase 3: Testing & Verification

**Task 3.1: Unit tests for extension**
- Mock OpenClaw PluginApi
- Test restore logic with temp files

**Task 3.2: Integration test**
- Full flow: Session → Extract → Restore via tool

**Task 3.3: Deploy extension**
- Copy to `~/.openclaw/extensions/brainsurgeon/`
- Add to `openclaw.json` `plugins.allow`
- Restart gateway
- Verify logs: "BrainSurgeon plugin registered successfully"

---

## Implementation Order

```
┌─────────────────────────────────────────────────────────────────┐
│  PHASE 1A: API Changes (Prerequisite)                           │
│  ├─ Task 2.1: Add sessionKey support to prune/compact           │
│  └─ Deploy and verify API changes                               │
├─────────────────────────────────────────────────────────────────┤
│  PHASE 1B: Extension Fixes                                      │
│  ├─ Task 1.2: Fix .json → .jsonl                                │
│  ├─ Task 1.1: Fix API endpoint paths (now unblocked)          │
│  ├─ Task 1.4: Fix config handling                               │
│  ├─ Task 1.5: Add toolCallEntryId support                       │
│  └─ Task 1.3: Delete/update extension.yaml                    │
├─────────────────────────────────────────────────────────────────┤
│  PHASE 2: Integration Testing                                   │
│  ├─ Task 3.1: Unit tests                                        │
│  ├─ Task 3.2: E2E integration test                              │
│  └─ Task 3.3: Production deployment                           │
└─────────────────────────────────────────────────────────────────┘
```

---

## Immediate Actions Required

1. **Decision needed:** Delete `extension.yaml` or update it?
2. **Question:** Can we add `sessionKey` support to API prune endpoint safely?
3. **Verify:** Does `api.pluginConfig` actually get populated from `openclaw.json`?

---

## Files to Modify

| File | Lines | Change Type |
|------|-------|-------------|
| `extensions/brainsurgeon/index.ts` | 111 | `.jsonl` → `.json` |
| `extensions/brainsurgeon/index.ts` | 267-278 | Fix endpoint paths |
| `extensions/brainsurgeon/index.ts` | 33-42 | Remove invalid config fields |
| `extensions/brainsurgeon/extension.yaml` | ALL | Delete or rewrite |
| `ts-api/src/domains/session/api/routes.ts` | TBD | Add sessionKey support |
| `ts-api/README.md` | TBD | Document extension integration |

---

## Verification Checklist

- [ ] Extension loads without errors in OpenClaw logs
- [ ] `restore_remote` tool appears in available tools
- [ ] Restore operation finds and restores extracted content
- [ ] Auto-prune triggers correctly after tool calls
- [ ] No `.jsonl` references remain in codebase
- [ ] All API endpoints use correct session path format
- [ ] Config values match between extension and API

---

## Notes

- Extension was disabled 2026-02-21 due to these issues
- API and WebUI continue to work independently
- Extension is the only broken component
- Skill documentation (SKILL.md) is accurate — no changes needed there

---

*ExecPlan created to track production readiness of BrainSurgeon extension.*
