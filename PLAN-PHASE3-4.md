# BrainSurgeon Phase 3-4: Smart Pruning & Configuration

## New Feature Set: Configurable Smart Pruning System

### Background
The TypeScript rewrite has achieved feature parity with Python. Now we're adding **Smart Pruning** — a sophisticated archival system that:
- Automatically moves old message content to separate files
- Keeps recent messages in the main session for fast access
- Provides configurable retention policies
- Cleans up when sessions are deleted

---

## Task Breakdown

---

### SP-01: Smart Pruning Toggle Configuration

**Goal:** Allow users to enable/disable smart pruning via the Web UI.

**Implementation:**
- Add `smart_pruning_enabled` field to `/api/config` GET response
- Add `POST /api/config` endpoint to update configuration
- Store configuration in new file: `{agentsDir}/.brainsurgeon/config.json`
- Web UI toggle switch in settings panel

**Files Modified:**
- `ts-api/src/app.ts` - new POST /api/config endpoint
- `ts-api/src/domains/config/` - new config service/repository

**Definition of Done:**
- [ ] `GET /api/config` returns `{ smart_pruning_enabled: boolean, ... }`
- [ ] `POST /api/config` accepts `{ smart_pruning_enabled: true/false }`
- [ ] Config persists between restarts in `.brainsurgeon/config.json`
- [ ] Web UI toggle reflects current state
- [ ] Toggle change takes effect immediately (no restart)
- [ ] If config file missing, defaults to `false`
- [ ] Only admin API keys can modify config (if API auth enabled)
- [ ] Invalid values return 400 with clear error message

**Verification:**
```bash
curl -X POST http://localhost:8000/api/config \
  -H "Content-Type: application/json" \
  -H "X-API-Key: admin-key" \
  -d '{"smart_pruning_enabled": true}'
# Expect: {"smart_pruning_enabled": true, "updated": true}
```

---

### SP-02: Smart Pruning Trigger Types Configuration

**Goal:** Users can configure which message types trigger smart pruning.

**Implementation:**
- New config field: `smart_prune_trigger_types` (array of strings)
- Valid values: `['thinking', 'tool_result', 'assistant', 'user', 'system']`
- Applied when determining what to move to extracted files
- Default: `['thinking', 'tool_result']` (large content types)

**Files Modified:**
- `ts-api/src/domains/config/` - config service
- `ts-api/src/domains/prune/services/prune-service.ts` - respect triggers

**Definition of Done:**
- [ ] `GET /api/config` returns `smart_prune_trigger_types: string[]`
- [ ] Only valid message types accepted (whitelist validation)
- [ ] Empty array means "prune nothing" (disabled)
- [ ] Invalid types in POST return 400 with list of allowed values
- [ ] Pruning logic checks message type before extracting
- [ ] Documented in UI what each type means
- [ ] Default config has `['thinking', 'tool_result']`

**Verification:**
```bash
curl http://localhost:8000/api/config | jq .smart_prune_trigger_types
# Expect: ["thinking", "tool_result"]
```

---

### SP-03: Smart Pruning Age Threshold Configuration

**Goal:** Configure how old messages must be before extraction.

**Implementation:**
- New config field: `smart_prune_age_threshold_hours` (number, default 24)
- Messages newer than threshold are never extracted
- Messages older than threshold become candidates for extraction
- UI shows human-readable format (e.g., "1 day", "7 days")

**Files Modified:**
- `ts-api/src/domains/config/config-service.ts`
- `ts-api/src/domains/prune/services/smart-prune-service.ts` (new)

**Definition of Done:**
- [ ] `GET /api/config` returns `smart_prune_age_threshold_hours: number`
- [ ] Accepts values 1-720 (hour range: 1h to 30 days)
- [ ] Out of range values return 400
- [ ] Age calculated from message timestamp or entry index fallback
- [ ] UI displays as "Keep messages from last: [24 hours ▼]"
- [ ] Changing threshold affects future prunes, not retroactive
- [ ] Setting to 0 disables age-based pruning (uses trigger types only)

**Verification:**
```bash
curl -X POST http://localhost:8000/api/config \
  -d '{"smart_prune_age_threshold_hours": 48}'
curl http://localhost:8000/api/config | jq .smart_prune_age_threshold_hours
# Expect: 48
```

---

### SP-04: Smart Pruning Retention Policy Configuration

**Goal:** Configure how long extracted files are kept.

**Implementation:**
- New config field: `extracted_files_retention_days` (number, default 90)
- Background cleanup job runs daily
- Extracted files older than retention are deleted
- Per-session extracted files tracked in index

**Files Modified:**
- `ts-api/src/domains/config/config-service.ts`
- `ts-api/src/domains/prune/services/retention-service.ts` (new)
- `ts-api/src/cron/` - scheduled cleanup task (or use node-cron)

**Definition of Done:**
- [ ] `GET /api/config` returns `extracted_files_retention_days: number`
- [ ] Accepts values 7-365 (1 week to 1 year)
- [ ] Setting to 0 means "keep forever"
- [ ] Background cleanup runs every 24 hours
- [ ] Cleanup logged to stderr with [RETENTION_CLEANUP] prefix
- [ ] Number of deleted files returned by cleanup endpoint
- [ ] `/api/admin/cleanup-extracted` for manual trigger
- [ ] Trashed sessions' extracted files retain trash expiration date

**Verification:**
```bash
# Trigger manual cleanup
curl -X POST http://localhost:8000/api/admin/cleanup-extracted \
  -H "X-API-Key: admin-key"
# Expect: {"cleaned": 15, "bytes_freed": 1048576}
```

---

### SP-05: Extracted Files Directory Structure

**Goal:** Extracted files organized in session-scoped subdirectories.

**Implementation:**
- Base path: `{openclawRoot}/extracted/{sessionId}/`
- Files named: `{entryIndex:04d}_{messageType}_{timestamp}.json`
- Index file at `{sessionId}/index.json` mapping entryIndex -> filename
- Size and date tracked in index for retention calculations

**Files Modified:**
- `ts-api/src/domains/prune/services/extracted-file-service.ts` (new)
- `ts-api/src/domains/prune/models/extracted-file.ts` (new)

**Definition of Done:**
- [ ] Directory created on first extraction: `.openclaw/extracted/{sessionId}/`
- [ ] Index file `extracted_index.json` tracks all extracted entries
- [ ] Original entry replaced with reference: `{extracted: true, ref: "...", hash: "sha256"}`
- [ ] Can reconstruct original session from main file + extracted files
- [ ] Hash verification on restore (detect corruption)
- [ ] Directory permissions: 700 (user-only access)
- [ ] Max directory depth: 1 (flat per-session)

**Directory Structure:**
```
.openclaw/
├── agents/
├── trash/
└── extracted/
    └── a1b2c3d4-session-id/
        ├── extracted_index.json
        ├── 0001_thinking_2024-01-15T10-30.json
        ├── 0015_tool_result_2024-01-15T11-45.json
        └── 0032_assistant_2024-01-16T09-00.json
```

---

### SP-06: Session Delete Cleans Extracted Files

**Goal:** Deleting a session must also clean up its extracted file directory.

**Implementation:**
- Modify `deleteSession()` to call `cleanupExtractedFiles(sessionId)`
- When moving to trash: move extracted dir to trash too
- When permanently deleting: wipe both session and extracted files
- Audit log includes extracted file count/size

**Files Modified:**
- `ts-api/src/domains/session/services/session-service.ts`
- `ts-api/src/domains/trash/services/trash-service.ts`
- `ts-api/src/shared/audit.ts`

**Definition of Done:**
- [ ] Deleting session moves `.jsonl` to trash
- [ ] Extracted files directory moved to `{trash}/{sessionId}_extracted/`
- [ ] Meta file includes extracted file count and size
- [ ] Restore puts both session file AND extracted files back
- [ ] Permanent delete removes session file AND extracted directory
- [ ] Audit log: `[AUDIT] {"action":"delete","extracted_files":5,"extracted_bytes":1024000}`
- [ ] Missing extracted directory doesn't fail delete (graceful)
- [ ] Recursive children delete also cleans their extracted files

**Verification:**
```bash
# Delete session with extracted files
curl -X DELETE http://localhost:8000/api/sessions/main/abc123
# Verify {sessionId} in extracted/ is gone or moved to trash/
```

---

### SP-07: Rate Limiting Configuration

**Goal:** Rate limiting configurable per endpoint category.

**Implementation:**
- Config fields:
  - `rate_limit_read_per_minute` (default: 60) - GET endpoints
  - `rate_limit_write_per_minute` (default: 30) - POST/PUT/DELETE
  - `rate_limit_admin_per_minute` (default: 10) - prune, delete, config changes
- Per-IP tracking with Redis-like TTL
- Configurable via POST /api/config

**Files Modified:**
- `ts-api/src/shared/middleware/rate-limit.ts`
- `ts-api/src/app.ts` - apply different limits to different route groups

**Definition of Done:**
- [ ] Three rate limit buckets: `read`, `write`, `admin`
- [ ] Read: GET /sessions, GET /agents, GET /config, etc.
- [ ] Write: PUT /entries, POST / prune, POST /restore, etc.
- [ ] Admin: DELETE, POST /config, POST /restart, POST /cleanup-extracted
- [ ] Configurable via POST /api/config
- [ ] Returns 429 with `Retry-After` header on limit
- [ ] Rate limit status in 429 response: `{"error": "...", "limit": 60, "window": "1m"}`
- [ ] In-memory store (no Redis required) with TTL cleanup
- [ ] Can disable by setting any limit to 0 (unlimited)

**Verification:**
```bash
# Set limits
curl -X POST http://localhost:8000/api/config \
  -d '{"rate_limit_read_per_minute": 100, "rate_limit_admin_per_minute": 5}'

# Test enforcement
for i in {1..11}; do curl -s http://.../config; done
# 10th succeeds, 11th returns 429
```

---

## Implementation Order

### Phase 3A: Core Config System (Foundation)
1. **SP-01** - Config toggle system
2. **SP-07** - Rate limiting configuration structure
3. Build new `ts-api/src/domains/config/` module
4. Create shared config service used by all domains

### Phase 3B: Smart Pruning Core
5. **SP-05** - Directory structure for extracted files
6. **SP-02** - Trigger types plumbing
7. **SP-03** - Age threshold logic
8. **SP-04** - Retention policy + background cleanup
9. **SP-06** - Delete cleanup integration

### Phase 3C: Polishing
10. Web UI settings panel for all new config options
11. Documentation update
12. Integration tests for extraction/restore cycle

---

## Unified Configuration Schema

```typescript
interface BrainSurgeonConfig {
  // Auto-refresh (existing)
  auto_refresh_interval_ms: number;
  readonly_mode: boolean;
  
  // Smart Pruning (new)
  smart_pruning_enabled: boolean;
  smart_prune_trigger_types: ('thinking' | 'tool_result' | 'assistant' | 'user' | 'system')[];
  smart_prune_age_threshold_hours: number;
  
  // Retention (new)
  extracted_files_retention_days: number;
  
  // Rate Limiting (new)
  rate_limit_read_per_minute: number;
  rate_limit_write_per_minute: number;
  rate_limit_admin_per_minute: number;
}
```

---

## Storage Location

```
.openclaw/
├── agents/
│   └── {agent}/sessions/
├── trash/
├── extracted/              # NEW: Extracted content
│   └── {sessionId}/
│       ├── extracted_index.json
│       └── {files...}
└── .brainsurgeon/          # NEW: BrainSurgeon-specific config
    └── config.json
```

---

## Testing Strategy

### Unit Tests
- Config validation (ranges, types)
- Rate limit store TTL
- Extracted file path generation
- Smart prune trigger matching

### Integration Tests
- Full extraction and restore cycle
- Config persistence across restarts
- Delete + extracted cleanup
- Rate limit enforcement with timing

### Manual Tests
- UI configuration panels
- Large session (>10MB) pruning performance
- Concurrent operations (parallel session access)

---

## Definition of Done for Smart Pruning Feature Complete

1. [ ] All config options accessible via Web UI settings panel
2. [ ] Smart prune extracts large messages based on age + triggers
3. [ ] Pruning creates files in `{openclaw}/extracted/{sessionId}/`
4. [ ] Session view shows "View extracted content" link for extracted entries
5. [ ] Delete session removes both session file AND extracted directory
6. [ ] Restore from trash brings back both session and extracted content
7. [ ] Background cleanup deletes extracted files older than retention policy
8. [ ] Rate limiting active with different limits per category
9. [ ] All operations logged in audit log
10. [ ] Documentation complete with diagrams

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Extracted files lost when session deleted | Move to trash first, permanent delete second |
| Corruption: extracted entry can't be restored | Hash verification + fallback to "content unavailable" |
| Config file corruption | JSON schema validation + backup on write |
| Rate limit memory exhaustion | TTL cleanup + max IP tracking limit |
| Concurrent prune on same session | Session-level lock during prune operation |

---

*Phase 3 begins with the Config Service foundation.*
