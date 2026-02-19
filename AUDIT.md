# BrainSurgeon — Honest Audit

**Date:** 2026-02-19  
**Auditor:** clawdi-claub  
**Method:** Live testing against real session data + code comparison with Python ground truth (api/main.py)

---

## Verdict Summary

The TypeScript rewrite builds and serves the UI, but **the frontend is broken** because the API speaks a different dialect than what the UI expects. Multiple response formats deviate from the Python implementation. Things that look working are half-working.

| Area | Status | Severity |
|------|--------|----------|
| Server starts | ✅ | — |
| Static files served | ✅ | — |
| `/api/agents` response format | ❌ | CRITICAL |
| `/api/config` field names | ❌ | CRITICAL |
| `/api/trash` response format | ❌ | CRITICAL |
| Prune response fields | ❌ | HIGH |
| Session detail (channel, tokens, etc.) | ❌ | HIGH |
| Session summary intelligence | ❌ | HIGH |
| Delete child sessions | ❌ | HIGH |
| Trash metadata (expires_at, etc.) | ❌ | HIGH |
| Restart endpoint (openclaw CLI) | ❌ | MEDIUM |
| Authentication (401 vs 403) | ⚠️ | LOW |
| Rate limiting | ❌ | MEDIUM |
| Path traversal protection | ❌ | MEDIUM |
| Audit logging | ❌ | MEDIUM |
| OpenClaw extension loading | ❓ | HIGH |
| README accuracy | ❌ | MEDIUM |
| docs/index.html | ✅ | — |
| Lock system | ✅ | — |
| Message bus (SQLite) | ✅ | — |
| JSONL library | ✅ | — |
| Unit tests (18) | ✅ | — |

---

## Critical Bugs — UI Is Currently Broken

### BUG-01: `/api/agents` returns bare array, UI expects object
**Confirmed live:**
```
Actual:   ["clawdi-claub", "crix-claub", "main"]
Expected: {"agents": ["clawdi-claub", "crix-claub", "main"]}
```
**Impact:** Agent filter never populates (`data.agents.forEach` fails on array). The entire agent filtering UI is broken.

---

### BUG-02: `/api/config` uses wrong field names
**Confirmed live:**
```
Actual:   {"autoRefreshInterval": 10000, "version": "2.0.0", "authEnabled": false, ...}
Expected: {"auto_refresh_interval_ms": 10000, "readonly_mode": false}
```
**Impact:** Auto-refresh reads `config.auto_refresh_interval_ms` which is always `undefined`, so it falls back to the hardcoded default (10000ms — happens to work). The `readonly_mode` flag is never set, so read-only mode cannot be communicated to the UI.

---

### BUG-03: `/api/trash` returns bare array, UI expects object
**Confirmed live:**
```
Actual:   []  (bare list)
Expected: {"sessions": [...]}
```
**Impact:** `data.sessions.length` fails. Trash count shows 0. Trash view is completely broken.

---

### BUG-04: Trash item fields don't match UI expectations
Python trash stores `.meta.json` files with:
```json
{"original_session_id": "...", "original_agent": "...", "trashed_at": "...", "expires_at": "..."}
```
TypeScript trash stores:
```json
{"id": "...", "agentId": "...", "sessionId": "...", "trashedAt": "..."}
```
The UI renders `s.original_session_id`, `s.original_agent`, `s.expires_at`. **None of these fields exist** in the TypeScript format.

---

### BUG-05: Prune response uses wrong field names
**Python returns:**
```json
{"pruned": true, "entries_pruned": 3, "original_size": 50000, "new_size": 20000, "saved_bytes": 30000, "mode": "full"}
```
**TypeScript returns:**
```json
{"pruned_count": 3, "original_size": 50000, "new_size": 30000}
```
**Impact:** After pruning, the UI tries to read `data.entries_pruned`, `data.saved_bytes`, and `data.mode` — all show as `undefined`. The dialog shows garbage.

---

## High Severity — Missing Data

### BUG-06: Session detail missing critical metadata fields
The UI session detail panel reads these fields. TypeScript API doesn't return them:

| Field | UI reads | TypeScript | Python |
|-------|----------|-----------|--------|
| `channel` | `data.channel` | ❌ | ✅ from `lastChannel` in sessions.json |
| `tokens` | `data.tokens` | ❌ | ✅ `totalTokens` |
| `contextTokens` | `data.contextTokens` | ❌ | ✅ |
| `parentId` | `data.parentId` | ❌ | ✅ |
| `children` | `data.children` | ❌ `[]` | ✅ populated |
| `systemPromptReport` | `data.systemPromptReport` | ❌ | ✅ |
| `resolvedSkills` | `data.resolvedSkills` | ❌ | ✅ |

**Note:** The TypeScript session-repository.ts DOES read `rawMeta` from sessions.json including `channel`, `tokens`, etc. But the `response-mapper.ts` doesn't include these in the output. The data exists — it's just not returned.

---

### BUG-07: Session summary is minimal, UI expects rich object
The delete dialog shows a rich summary with `key_actions`, `user_requests`, `thinking_insights`, `tools_used`, `models_used`, `errors`, `duration_estimate`, `has_git_commits`, etc.

**TypeScript returns:**
```json
{"summary": "Started with: \"...\"\nEnded with: \"...\"", "messageCount": 46, ...}
```
**Python returns:**
```json
{"session_id": "...", "summary": {"key_actions": [...], "user_requests": [...], "thinking_insights": [...], "tools_used": [...], "models_used": [...], "errors": [...], "duration_estimate": 45.3, "has_git_commits": true, ...}}
```

**Impact:** The pre-delete summary dialog shows nothing meaningful.

---

### BUG-08: Delete doesn't remove child sessions
Python `DELETE /sessions/{agent}/{session_id}` also moves all child sessions to trash. TypeScript only deletes the target session. Users will have orphaned child sessions accumulating.

---

### BUG-09: Trash restore doesn't re-add to sessions.json
TypeScript moves file back but doesn't re-add to sessions.json. The session won't appear in the UI after restore. Python re-adds with a basic entry if missing.

---

## Medium Severity — Features Missing

### BUG-10: Restart endpoint doesn't call OpenClaw CLI
Python:
```python
subprocess.run(["openclaw", "gateway", "restart", "--delay", str(req.delay_ms)])
```
TypeScript:
```typescript
setTimeout(() => process.exit(0), 100);  // Just kills itself
```
This restarts the API server, not the OpenClaw gateway.

---

### BUG-11: No rate limiting
Python uses `slowapi` with per-endpoint limits (60/min reads, 30/min writes, 5/min restart). TypeScript has none. Documented in README but not implemented.

---

### BUG-12: No path traversal protection
Python validates all agent/session IDs: `^[a-zA-Z0-9_-]+$`. TypeScript accepts any path value including `../../etc/passwd`. Security risk for network-exposed deployments.

---

### BUG-13: No audit logging for destructive operations
Python logs all destructive operations to stderr: `action=delete agent=main session=abc user=key123...`  
TypeScript has no audit logging.

---

### BUG-14: Auth returns 401, Python returns 403
Minor: Python uses HTTP 403 Forbidden for bad/missing API keys. TypeScript uses 401 Unauthorized. Neither wrong, but 403 is semantically correct for "you are known but not authorized".

---

### BUG-15: OpenClaw extension loading — unverified
`extension.yaml` defines the plugin manifest. `extension.ts` has the implementation. But:
- Does OpenClaw actually load `extension.ts` from the plugin directory?
- What's the correct plugin directory path?
- Is `@sinclair/typebox` installed?
- Has anyone tested `restore_response` tool end-to-end?

**Status: Unknown / Untested**

---

### BUG-16: README still references Python implementation
- References Python/FastAPI/uvicorn as the runtime
- Port 8654 instead of 8000
- Python startup commands in Quick Start
- No TypeScript/Node.js setup instructions

---

## What's Actually Working Well

- **Server starts cleanly** — Hono, SQLite bus, static files
- **Session list** — Data structure is compatible (`sessions`, `agents`, `total_size`, `messages`, `tool_calls`, etc.)
- **Lock system** — Properly implemented, tested, compatible with extension.ts
- **Message bus** — SQLite-backed, persistent, 8 message types documented
- **JSONL library** — Streaming, parsing, serialization all correct
- **Prune logic** — Light/full/smart/enhanced modes are solid implementations
- **External storage** — Prune → externalize → restore pipeline is architecturally sound
- **Extension event forwarding** — extension.ts subscribes to events and forwards to API
- **`docs/index.html`** — Beautiful landing page, up to date

---

## Root Cause

The rewrite was done bottom-up (good domain layer) but the API contract (field names, response shapes) was not systematically verified against the frontend contract. The Python API was not used as the specification — it should have been read line by line before writing a single endpoint.
