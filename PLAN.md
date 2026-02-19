# BrainSurgeon — Implementation Plan

**Goal:** Complete TypeScript rewrite with full feature parity. Something solid, trusted, indispensable.  
**Ground truth:** `api/main.py` (Python) + `web/app.js` (frontend contract)  
**Current state:** API speaks a different dialect than the UI. Multiple critical response format mismatches.

---

## Project-Level Definition of Done

The BrainSurgeon rewrite is DONE when:

1. **Every feature that works in the Python API works in TypeScript** — verified via the same browser UI, not just curl
2. **All response field names match** — the UI works without modifying a single line of app.js
3. **Security baseline met** — auth, CORS, path traversal, audit logging all work
4. **README accurate** — describes TypeScript setup, correct ports, correct env vars
5. **Tests cover critical paths** — unit tests + HTTP integration tests pass in CI
6. **OpenClaw extension verified** — restore_response tool works end-to-end with real session data
7. **No known regressions** — all Python features present in TypeScript

---

## Task Ordering

### Phase 1: Fix the broken contract (do first — unblocks testing everything else)

**P1-01 / Fix `/api/agents` response format**  
**P1-02 / Fix `/api/config` field names**  
**P1-03 / Fix `/api/trash` response format + field names**  
**P1-04 / Fix prune response field names**  
**P1-05 / Fix session detail missing fields (channel, tokens, parentId, children, systemPromptReport, resolvedSkills)**

After P1: The UI should be fully usable for basic read/browse/delete/prune operations.

### Phase 2: Restore missing business logic

**P2-01 / Session summary — port Python's rich summary generation**  
**P2-02 / Delete child sessions**  
**P2-03 / Trash restore → re-add to sessions.json**  
**P2-04 / Restart endpoint → call `openclaw gateway restart` CLI**

After P2: Feature parity with Python for all user-visible flows.

### Phase 3: Security & reliability

**P3-01 / Path traversal protection**  
**P3-02 / Audit logging**  
**P3-03 / Rate limiting**  
**P3-04 / Auth status code (403 not 401)**

### Phase 4: Documentation

**P4-01 / Update README.md** — TypeScript, port 8000, env vars  
**P4-02 / Verify OpenClaw extension loads** — test restore_response end-to-end  
**P4-03 / Message bus documentation**

### Phase 5: Polish

**P5-01 / Integration test suite** (HTTP-level tests for all endpoints)  
**P5-02 / Update kanban board** — close completed items correctly

---

## Detailed Task Specs

---

### P1-01 — Fix `/api/agents` response format

**File:** `ts-api/src/app.ts`

**Problem:**
```
Actual:   ["clawdi-claub", "main"]
Expected: {"agents": ["clawdi-claub", "main"]}
```
Frontend: `data.agents.forEach(agent => ...)` — crashes on array.

**Fix:**
```typescript
apiApp.get('/agents', async (c) => {
  const sessions = await sessionService.listSessions();
  const agents = [...new Set(sessions.map(s => s.agentId))];
  return c.json({ agents });  // ← wrap in object
});
```

**Definition of Done:**
- [ ] `curl /api/agents | jq .agents` returns array
- [ ] Agent filter buttons appear in the UI
- [ ] Selecting "clawdi-claub" filters session list correctly

---

### P1-02 — Fix `/api/config` field names

**File:** `ts-api/src/app.ts`

**Problem:**
```
Actual:   {"autoRefreshInterval": 10000, "readOnly": false, ...extra fields}
Expected: {"auto_refresh_interval_ms": 10000, "readonly_mode": false}
```
Frontend uses `config.auto_refresh_interval_ms` for the session auto-refresh timer.

**Fix:**
```typescript
apiApp.get('/config', (c) => c.json({
  auto_refresh_interval_ms: parseInt(process.env.AUTO_REFRESH_MS || '10000', 10),
  readonly_mode: READONLY,
}));
```

**Definition of Done:**
- [ ] `curl /api/config | jq .auto_refresh_interval_ms` returns number
- [ ] `curl /api/config | jq .readonly_mode` returns boolean
- [ ] Session detail view auto-refreshes at configured interval
- [ ] `AUTO_REFRESH_MS=30000` env var changes the interval

---

### P1-03 — Fix `/api/trash` response format + field names

**Files:** `ts-api/src/domains/trash/repository/trash-repository.ts`, `ts-api/src/domains/trash/services/trash-service.ts`, `ts-api/src/domains/trash/api/routes.ts`

**Problem A — GET /api/trash:**
```
Actual:   [] (bare array)
Expected: {"sessions": [...]}
```

**Problem B — Trash item fields:**
```
Actual:   {"id": "...", "agentId": "...", "sessionId": "..."}  
Expected: {"original_session_id": "...", "original_agent": "...", "trashed_at": "...", "expires_at": "..."}
```

The trash format must match exactly what the UI renders in the trash modal.

**Fix — Trash list route:**
```typescript
app.get('/', async (c) => {
  const sessions = await trashService.list();
  return c.json({ sessions });  // ← wrap in object
});
```

**Fix — Trash repository:** Store metadata file alongside each trashed session (same as Python: `{agent}_{session_id}_{timestamp}.meta.json` with `original_session_id`, `original_agent`, `trashed_at`, `expires_at`).

**Definition of Done:**
- [ ] `curl /api/trash | jq .sessions` returns array (not null)
- [ ] Each item has `original_session_id`, `original_agent`, `trashed_at`, `expires_at`
- [ ] Trash count in stats bar shows correct number
- [ ] Trash modal opens and shows session list
- [ ] Expiry date shows correctly (14 days from deletion)

---

### P1-04 — Fix prune response field names

**File:** `ts-api/src/domains/session/api/routes.ts`

**Problem:**
```
Actual:   {"pruned_count": 3, "original_size": 50000, "new_size": 20000}
Expected: {"pruned": true, "entries_pruned": 3, "original_size": 50000, "new_size": 20000, "saved_bytes": 30000, "mode": "full"}
```

**Fix:**
```typescript
return c.json({
  pruned: result.pruned_count > 0,
  entries_pruned: result.pruned_count,
  original_size: result.original_size,
  new_size: result.new_size,
  saved_bytes: result.original_size - result.new_size,
  mode: options.keepRecent === -1 ? 'light' : 'full',
});
```

**Definition of Done:**
- [ ] Prune dialog shows "Pruned X entries. Saved Y bytes. Mode: full"
- [ ] Numbers are correct (not 0 or undefined)
- [ ] Works for both light prune and full prune

---

### P1-05 — Fix session detail missing metadata fields

**Files:** `ts-api/src/domains/session/api/response-mapper.ts`, `ts-api/src/domains/session/repository/session-repository.ts`

**Problem:** These fields are read from sessions.json by the repository (in `rawMeta`) but the response mapper doesn't include them in the HTTP response.

**Missing fields the UI reads:**
- `channel` — from `rawMeta.channel`
- `tokens` — from `rawMeta.tokens`  
- `contextTokens` — from `rawMeta.contextTokens`
- `inputTokens` / `outputTokens` — from `rawMeta`
- `parentId` — from `rawMeta.parentSessionId`
- `children` — requires querying other sessions to find which have this as parent
- `systemPromptReport` — from sessions.json `systemPromptReport` field
- `resolvedSkills` — from sessions.json `skillsSnapshot.resolvedSkills`

The raw sessions.json has all of this. The repository reads some of it. The mapper needs to pass it through.

**Additional:** Repository needs to read `systemPromptReport` and `skillsSnapshot` from sessions.json too.

**Definition of Done:**
- [ ] Session detail panel shows `Channel: telegram` (or whatever is set)
- [ ] Token counts show actual numbers
- [ ] Parent session link appears when session has a parent
- [ ] Children sessions listed when they exist
- [ ] Resolved skills shown in metadata panel

---

### P2-01 — Session summary — port Python's rich summary

**File:** `ts-api/src/domains/session/services/session-service.ts` (new method) or separate service

**Problem:** The pre-delete dialog requires a rich object:
```typescript
{
  key_actions: string[],
  user_requests: string[],
  thinking_insights: string[],
  tools_used: string[],
  models_used: string[],
  errors: string[],
  duration_estimate: number | null,
  has_git_commits: boolean,
  files_created: string[],
  meaningful_messages: number,
  message_count: number,
  tool_calls: number,
}
```

Port Python's `generate_session_summary()` and `is_heartbeat_message()` logic exactly. It scans entries for user requests, assistant actions, thinking blocks (non-heartbeat), tools used, models, git commits.

**Definition of Done:**
- [ ] Delete dialog shows the summary box with content
- [ ] User requests list shows what the user asked
- [ ] Tools used list shows actual tool names
- [ ] Models used matches what the session used
- [ ] Duration estimate is plausible
- [ ] Heartbeat/automated messages excluded from summary

---

### P2-02 — Delete child sessions

**File:** `ts-api/src/domains/session/services/session-service.ts`

**Problem:** When a parent session is deleted, its children should also be moved to trash (Python does this).

**Fix:** After deleting the target session, scan sessions.json for entries where `parentSessionId === sessionId` and delete those too.

**Definition of Done:**
- [ ] Deleting a session with children also removes children from the session list
- [ ] Children appear in trash
- [ ] Orphaned `.jsonl` files are not left behind

---

### P2-03 — Trash restore → re-add to sessions.json

**File:** `ts-api/src/domains/trash/services/trash-service.ts`

**Problem:** TypeScript moves the `.jsonl` file back but doesn't add it back to sessions.json. The session is invisible after restore.

**Fix:** After moving the file back, add a basic entry to sessions.json if missing.

**Definition of Done:**
- [ ] Restoring a session makes it appear in the session list immediately
- [ ] Session can be opened after restore

---

### P2-04 — Restart endpoint → call `openclaw gateway restart`

**File:** `ts-api/src/app.ts`

**Problem:** TypeScript calls `process.exit(0)` which restarts the BrainSurgeon API, not the OpenClaw gateway.

**Fix:**
```typescript
import { execSync } from 'node:child_process';

apiApp.post('/restart', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const delayMs = body.delay_ms || 5000;
  
  // Try OpenClaw CLI first
  try {
    const result = execSync(`openclaw gateway restart`, { timeout: 10000 });
    return c.json({ restarted: true, delay_ms: delayMs, note: body.note });
  } catch (e) {
    // Fallback for containerized environments
    return c.json({ 
      restarted: true, 
      simulated: true, 
      delay_ms: delayMs, 
      note: body.note, 
      message: 'Restart command received. When running in container, restart on host.' 
    });
  }
});
```

**Definition of Done:**
- [ ] Restart button in UI shows success dialog
- [ ] `openclaw gateway restart` is called when available
- [ ] Graceful fallback when CLI not in PATH

---

### P3-01 — Path traversal protection

**File:** New `ts-api/src/shared/middleware/sanitize.ts`

**Problem:** Agent and session ID parameters are used directly in file paths. `../../etc/passwd` would be a valid agent name.

**Fix:**
```typescript
const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

export function sanitizeId(value: string, field: string): string {
  if (!value) throw new HTTPException(400, { message: `${field} cannot be empty` });
  if (!SAFE_ID.test(value)) throw new HTTPException(400, { message: `Invalid ${field}: only alphanumeric, hyphens, underscores` });
  return value;
}
```
Apply to all agent/session_id parameters in all routes.

**Definition of Done:**
- [ ] `curl /api/sessions/../etc/passwd` returns 400
- [ ] `curl /api/sessions/valid-agent/valid-session` works normally
- [ ] Test: sanitizeId with various inputs

---

### P3-02 — Audit logging

**File:** New `ts-api/src/shared/logging/audit.ts`

**Problem:** Python logs all destructive operations. TypeScript doesn't log anything.

**Fix:**
```typescript
export function auditLog(action: string, agent: string, sessionId?: string, apiKey?: string, details?: Record<string, unknown>) {
  const log = {
    timestamp: new Date().toISOString(),
    action,
    agent,
    sessionId,
    apiKeyPrefix: apiKey ? apiKey.slice(0, 8) + '...' : null,
    ...details,
  };
  console.error('[AUDIT]', JSON.stringify(log));
}
```

Call before: delete, prune, edit, restore, permanent-delete, restart.

**Definition of Done:**
- [ ] Delete: `[AUDIT] {"action":"delete","agent":"main","sessionId":"abc..."}`
- [ ] Prune: logged with keep_recent value
- [ ] Edit: logged with entry index
- [ ] Restart: logged

---

### P3-03 — Rate limiting

**File:** `ts-api/src/shared/middleware/rate-limit.ts`

**Problem:** Python has per-endpoint rate limits. TypeScript has none.

**Fix:** Implement simple in-memory per-IP rate limiter:
```typescript
// 60/min for reads, 30/min for writes, 5/min for restart
```

**Definition of Done:**
- [ ] Sending 61 GET requests in 60s returns 429
- [ ] Rate limit resets after window
- [ ] Retry-After header present on 429

---

### P3-04 — Auth status code (403 not 401)

**File:** `ts-api/src/shared/middleware/auth.ts`

**Fix:** Change 401 → 403.

**Definition of Done:**
- [ ] Wrong API key → 403 Forbidden
- [ ] Missing API key → 403 Forbidden

---

### P4-01 — Update README.md

**Problem:** README describes Python API. TypeScript is the new implementation.

**Required changes:**
- Replace Python/FastAPI/uvicorn references with TypeScript/Hono/Node.js
- Update port: 8654 → 8000
- Add TypeScript build/start commands
- Update Docker instructions (Dockerfile is already in ts-api/)
- Update env var table (add AUTO_REFRESH_MS)
- Update Project Structure section
- Keep all the good stuff (security docs, nginx config, etc.)

**Definition of Done:**
- [ ] `npm install && npm run build && npm start` produces a working server
- [ ] All env vars documented with correct names
- [ ] Port 8000 everywhere
- [ ] No mentions of Python, FastAPI, uvicorn, or port 8654

---

### P4-02 — Verify OpenClaw extension loads

**Questions to answer:**
- Where does OpenClaw look for extensions? (`~/.openclaw/extensions/` or via `openclaw.plugin.json`?)
- Does it load TypeScript directly or needs compilation?
- What version of the Plugin API does extension.ts target?
- Is `@sinclair/typebox` installed in the extension context?

**Test:**
1. Symlink brainsurgeon to extensions directory
2. Restart OpenClaw
3. Check if `restore_response` tool appears in session
4. Prune a session via BrainSurgeon, then call `restore_response` tool
5. Verify content is restored

**Definition of Done:**
- [ ] OpenClaw shows brainsurgeon as a loaded plugin (check logs)
- [ ] `restore_response` tool appears in tool list
- [ ] Full prune → restore cycle works end-to-end

---

### P4-03 — Message bus documentation

**File:** New `ts-api/docs/MESSAGE_BUS.md`

**Content:**
- What the message bus is (SQLite-backed pub/sub)
- All 8 message types with payloads
- Producer → Consumer mapping
- How extension events flow to the API
- How to subscribe in new code

**Definition of Done:**
- [ ] Each message type documented with payload shape
- [ ] Example code for publishing and subscribing
- [ ] Flow diagram: extension → bus → API → bus

---

### P5-01 — HTTP integration test suite

**File:** `ts-api/src/test/integration.test.ts`

**Tests required:**
- [ ] GET /api/health → 200 `{status: "ok"}`
- [ ] GET /api/agents → `{agents: [...]}`
- [ ] GET /api/config → `{auto_refresh_interval_ms: ..., readonly_mode: ...}`
- [ ] GET /api/sessions → `{sessions: [...], agents: [...], total_size: ...}`
- [ ] GET /api/sessions/:agent/:id → all required fields present
- [ ] DELETE /api/sessions/:agent/:id → moves to trash
- [ ] GET /api/trash → `{sessions: [...]}` with correct field names
- [ ] POST /api/trash/:agent/:id/restore → session reappears in session list
- [ ] POST /api/sessions/:agent/:id/prune → correct response fields
- [ ] PUT /api/sessions/:agent/:id/entries/:index → entry updated
- [ ] GET /api/sessions/:agent/:id/summary → rich summary object
- [ ] Auth: missing key → 403, invalid key → 403, valid key → 200
- [ ] Path traversal: `../etc` → 400

**Definition of Done:**
- [ ] All tests pass
- [ ] Tests run in isolation (use temp dir, not real OpenClaw data)
- [ ] Tests added to CI

---

### P5-02 — Close kanban correctly

After implementation, update the kanban board with:
- Verified evidence for each completed task
- Integration test results
- What was verified end-to-end vs unit-tested only

---

## What Order To Work In

1. **P1-01 through P1-05** — Do all five contract fixes before anything else. This unblocks UI testing for everything.
2. **P2-01 through P2-04** — Business logic parity. Do in order (summary → delete children → restore → restart).
3. **P3-01, P3-02** — Path traversal + audit logging. Quick wins, high value.
4. **P4-01** — README. Do while server is running and testable.
5. **P4-02** — Extension verification. Needs a real OpenClaw session to test against.
6. **P3-03, P3-04** — Rate limiting + auth status. Polish.
7. **P5-01** — Integration tests. Final verification gate.
8. **P4-03, P5-02** — Documentation and board cleanup.

---

## How to Verify the Whole Thing Is Done

Start the server. Open the browser. Walk through this checklist:

```
[ ] Sessions load in the grid
[ ] Agent filter buttons appear (All / main / clawdi-claub / ...)
[ ] Clicking an agent filters the session list
[ ] Clicking a session opens detail view
[ ] Detail view shows: agent, size, messages, tool calls, duration, created, updated
[ ] Detail view shows: channel, tokens, parent/children links
[ ] Metadata section expands and shows resolved skills
[ ] Models shown in header, most recent highlighted
[ ] Prune dialog opens with options
[ ] Pruning a session shows "X entries pruned, saved Y bytes, mode: full"
[ ] Delete dialog shows session summary (not empty)
[ ] Delete moves session to trash (count increments)
[ ] Trash modal opens and shows trashed sessions
[ ] Trash shows expiry date 14 days from now
[ ] Restore brings session back to session list
[ ] Permanently delete from trash works
[ ] Compact button triggers successfully (or shows appropriate error)
[ ] Restart button shows dialog and triggers correctly
[ ] API key input: entering wrong key shows 403 error on next request
[ ] Auto-refresh: session detail updates when new entries appear
[ ] Path traversal: directly calling /api/sessions/../etc returns 400
[ ] AUDIT: stderr shows log lines for all destructive operations
[ ] Extension: restore_response tool available in OpenClaw
```

Only when every checkbox is ticked: the project is done.
