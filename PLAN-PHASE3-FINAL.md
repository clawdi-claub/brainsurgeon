# BrainSurgeon Phase 3: Smart Pruning System

## Architecture Decisions (Locked)

| Aspect | Decision |
|--------|----------|
| **Security (auth/CORS)** | ENV vars only. No runtime change. Empty/null `API_KEYS` = open access. |
| **Rate limiting** | nginx config only. Remove from app middleware (already documented in README). |
| **Runtime config** | Smart pruning settings only. Persisted to `.brainsurgeon/config.json`. |
| **Retention time** | Human-readable duration string: "5d", "6h", "30m", "1d"=default. Parsed via `ms` library. |
| **Logging** | OpenClaw native logging facility with debug/info levels. No console output. |
| **Smart prune trigger** | Time-based cron + File mtime check. Skip if unchanged since last run. |

---

## Configuration Schema

### Environment Variables (read at startup, immutable)
```bash
# Security (optional - if unset, no auth required)
BRAINSURGEON_API_KEYS=key1,key2,key3
BRAINSURGEON_CORS_ORIGINS=http://localhost:3000,https://bs.example.com

# Rate limiting (nginx config - see README)
# BRAINSURGEON_RATE_LIMIT_READ=60      # per minute
# BRAINSURGEON_RATE_LIMIT_WRITE=30
# BRAINSURGEON_RATE_LIMIT_ADMIN=10

# Paths
BRAINSURGEON_AGENTS_DIR=/path/to/.openclaw/agents
AUTO_REFRESH_MS=10000
```

### Runtime Config (`GET|POST /api/config` → `.brainsurgeon/config.json`)
```typescript
interface SmartPruningConfig {
  enabled: boolean;                    // Master toggle
  
  // What to extract
  trigger_types: ('thinking' | 'tool_result' | 'assistant' | 'user' | 'system')[];
  age_threshold_hours: number;         // 0 = extract all matching triggers
  
  // When to auto-run
  auto_cron: string;                   // Cron expression, default: "*/2 * * * *"
  last_run_at: string | null;          // ISO timestamp
  
  // Extracted file retention
  retention: string;                   // "24h", "1d", "7d", "30d" etc
  retention_cron: string;              // Cleanup schedule, default: "0 */6 * * *"
  last_retention_run_at: string | null;
  
  // Debug options
  keep_restore_remote_calls: boolean;  // Keep tool calls in session? Default: false
}
```

---

## restore_remote Tool Design

**Tool invocation:**
```
restore_remote --session ${session-id} --entry ${session-entry-id} [--keys key1,key2,...]
```

**Behavior:**
1. Agent/tool calls `restore_remote` when encountering `[[extracted]]` placeholder
2. System loads content from `agents/{agent}/sessions/extracted/{session}/{entry-id}.jsonl`
3. Placeholders replaced with actual values
4. **Tool call is CONSUMED (removed from session)** - agent sees content as native
5. Session rewound to just before the tool call

**Parameters:**
- `--session`: Session ID
- `--entry`: Entry ID (`__id` field from the entry with extracted content)
- `--keys`: Optional comma-separated list of keys to restore (default: ALL keys)

**Debug Mode:**
- Config field `keep_restore_remote_calls: boolean` (default: false)
- When false (default): tool calls consumed after restoration (invisible to agent)
- When true: tool calls preserved in session for debugging purposes

**Example Flow:**
```
1. Session entry: {"__id": "ent_123", "data": {"thinking": "[[extracted]]"}}
2. Agent sees [[extracted]] and calls: restore_remote --session abc --entry ent_123
3. Tool loads: extracted/abc/ent_123.jsonl → {"thinking": "full content..."}
4. Entry becomes: {"__id": "ent_123", "data": {"thinking": "full content..."}}
5. Tool call removed from session (unless debug mode on)
6. Agent continues with full content, unaware of restoration
```

---

## Revised Task Breakdown

---

### SP-01: Config Service Foundation

**Goal:** Separate ENV-only security from runtime smart-pruning config.

**Implementation:**
- Create `ts-api/src/domains/config/` module
- Config file: `{agentsDir}/../.brainsurgeon/config.json` (sibling of `agents/`)
- GET `/api/config` → runtime config only (not env vars)
- POST `/api/config` → validate + write + return updated config
- If config file missing on startup, create with defaults

**ENV → Config split:**
- **ENV only:** `API_KEYS`, `CORS_ORIGINS`, `AGENTS_DIR`, `AUTO_REFRESH_MS`
- **Runtime:** All keys in `SmartPruningConfig` above

**Definition of Done:**
- [ ] `GET /api/config` returns `SmartPruningConfig` (no security or CORS in response)
- [ ] `POST /api/config` validates all fields, persists to `.brainsurgeon/config.json`
- [ ] Validation errors return 400 with field-specific messages
- [ ] Config auto-created on startup with sensible defaults
- [ ] Changes take effect immediately (in-memory cache invalidated)
- [ ] Auth required for POST if `API_KEYS` env var set

**Verification:**
```bash
# Get current config (no auth needed for GET)
curl http://localhost:8000/api/config
# {"enabled":false,"trigger_types":["thinking","tool_result"],"age_threshold_hours":24,"auto_cron":"*/2 * * * *","retention":"24h"}

# Update (auth required if API_KEYS set)
curl -X POST http://localhost:8000/api/config \
  -H "X-API-Key: mykey" \
  -H "Content-Type: application/json" \
  -d '{"enabled":true,"age_threshold_hours":48}'
```

---

### SP-02: Time Span Parser Utility

**Goal:** Parse human durations like "5d", "6h", "30m", "1d" → milliseconds.

**Validation rules:**
- Format: `<number><unit>` where unit is `m|h|d|w` (minute, hour, day, week)
- Min: "30m" (30 minutes)
- Max: "52w" (1 year)
- Case insensitive: "5D" == "5d"
- Can combine: "1d12h" → 36 hours (optional enhancement)

**Definition of Done:**
- [ ] `parseDuration("24h")` → 86400000
- [ ] `parseDuration("1d")` → 86400000  
- [ ] `parseDuration("6h30m")` → 23400000 (optional)
- [ ] Invalid format throws with specific message: "Invalid duration '5x'. Use m, h, d, or w"
- [ ] Out of range throws with min/max hints
- [ ] Exported `formatDuration(ms)` → "2d 4h" for UI display

---

### SP-03: Configurable Smart Prune Trigger

**Goal:** Runtime config for what/when to extract.

**Fields:**
- `trigger_types`: Which message content types are candidates for extraction
  - `"thinking"`: Large reasoning blocks (default: included)
  - `"tool_result"`: Tool outputs, often large JSON (default: included)
  - `"assistant"`: Standard assistant responses (default: not included unless very large)
  - `"user"`: User messages (default: not included)
  - `"system"`: System messages (default: not included)
- `age_threshold_hours`: Messages newer than this are never extracted
  - 0 = extract based on trigger_types only (no age protection)
  - 24 = keep last 24h of messages inline

**Definition of Done:**
- [ ] `enabled` toggle works (entire smart prune system on/off)
- [ ] Empty `trigger_types` = no extraction (same as enabled=false)
- [ ] Age threshold 0 = extract all matching triggers regardless of age
- [ ] Age threshold > 0 = skip messages newer than threshold
- [ ] Per-entry decision: `shouldExtract(entry, config)` returns boolean
- [ ] Decision logged at debug level: "Entry 45: thinking, 48h old → EXTRACT"

---

### SP-04: Auto-Trigger Cron System

**Goal:** Time-based automatic smart prune runs.

**Implementation:**
- Cron expression in config: `auto_cron` (default: "*/2 * * * *" = every 2 min)
- Library: `node-cron` or native `setInterval` with cron-parser
- On tick:
  1. Load all sessions
  2. For each session: check mtime (via `stat()`)
  3. If mtime > `last_run_at`: process session
  4. Skip if mtime unchanged
- Set `last_run_at` to now after run completes
- If `last_run_at` is null (first run), process all sessions

**Definition of Done:**
- [ ] Cron parses expression and schedules correctly
- [ ] Job starts on app startup
- [ ] "Session main/abc123 unchanged since 2024-01-15T10:00:00Z, skipping" (debug log)
- [ ] "Processing session main/abc123, 15 entries to check" (debug log)
- [ ] `last_run_at` updated in config file after successful completion
- [ ] Failed session doesn't stop other sessions from processing
- [ ] Disabling `enabled` stops cron (or skips processing)
- [ ] Changing `auto_cron` updates schedule without restart

---

### SP-05: Directory Structure & Extraction Logic

**Goal:** Extract large/old content to separate files in session-scoped dirs.

**Directory layout:**
```
.openclaw/
├── agents/
├── trash/
└── extracted/                      # NEW
    └── {agent}_{sessionId}/        # e.g., "main_abc123def"
        ├── index.json              # Maps entry index → filename
        ├── 0045_thinking.json      # Extracted entry 45
        ├── 0120_tool_result.json   # Extracted entry 120
        └── 0345_thinking.json      # Entry 345
```

**Extraction process:**
1. Identify entry to extract (via SP-03 logic)
2. Write full content to `extracted/{agent}_{sessionId}/{index:04d}_{type}.json`
3. Replace entry in `.jsonl` with: `{extracted: true, ref: "0045_thinking", hash: "sha256:...", size: 12345}`
4. Update `index.json` with metadata

**Definition of Done:**
- [ ] Directory created on first extraction for session
- [ ] Extracted file contains full original entry JSON
- [ ] Main `.jsonl` has placeholder with SHA256 hash
- [ ] `index.json` tracks: original entry index, filename, hash, size, extracted_at
- [ ] Entry can be reconstructed: placeholder + read file → original
- [ ] Hash verification on load fails gracefully (log warning, return placeholder)
- [ ] Directory permissions 700
- [ ] Atomic write: write to temp file, fsync, rename

---

### SP-06: Session View with Extraction

**Goal:** Web UI shows which entries are extracted and allows viewing them.

**API changes:**
- `GET /api/sessions/:agent/:id` → placeholder entries marked with `extracted: true`
- `GET /api/sessions/:agent/:id/entries/:index/extracted` → fetch extracted content

**UI behavior:**
- Entry list shows "📎 extracted" badge for extracted entries
- Click opens modal/popover with full content (fetched on demand)
- Inline preview shows first 200 chars + size

**Definition of Done:**
- [ ] Session detail returns entries with `extracted: true` markers
- [ ] New endpoint serves extracted content by index
- [ ] UI shows visual distinction for extracted vs inline
- [ ] Clicking extracted entry fetches and displays full content
- [ ] Network error handled gracefully (content unavailable)
- [ ] Large extracted file streams without memory explosion

---

### SP-07: Retention Cleanup System

**Goal:** Parseable retention duration + cron-based cleanup.

**Config:**
- `retention`: "24h" | "1d" | "7d" | "30d" etc (default: "24h")

**On app startup:**
1. Run retention cleanup immediately
2. Start retention cron (schedule: derived from retention duration, or separate config?)

**Decision:** How often to run retention?
- Option A: Run every 6 hours, delete files older than `retention`
- Option B: Run once when files reach `retention` age (requires tracking)

**Decision:** Option A is simpler. Run every 6h, delete files where:
`now - file.mtime > parseDuration(config.retention)`

**Retention cron:** Separate from smart prune cron. Configurable? Or hardcode 6h?
- User said "Cron job using the set config" - so let's add `retention_cron` → default "0 */6 * * *" (every 6 hours)

**Definition of Done:**
- [ ] `parseDuration(config.retention)` used to calculate cutoff time
- [ ] Cleanup runs on startup
- [ ] Cleanup runs on `retention_cron` schedule
- [ ] Deleted files logged at info level: "[RETENTION] Deleted 15 extracted files (1.2 MB)"
- [ ] Cleanup stats returned: `{cleaned: 15, bytes: 1258291, errors: 0}`
- [ ] Failed deletions logged but don't stop cleanup

---

### SP-08: Delete = Full Cleanup

**Goal:** Deleting session removes both `.jsonl` and extracted dir.

**Trash flow:**
- Move `{agent}_{sessionId}/` dir from `extracted/` to `trash/{agent}_{sessionId}_extracted_{timestamp}/`
- Meta file includes extracted file count and size

**Permanent delete:**
- Delete `.jsonl` file
- Delete extracted directory recursively

**Audit log entries:**
```json
{"action":"delete","agent":"main","sessionId":"abc123","movedToTrash":true}
{"action":"delete_extracted","agent":"main","sessionId":"abc123","filesRemoved":15,"bytesRemoved":1258291}
```

**Definition of Done:**
- [ ] Session delete moves extracted dir to trash
- [ ] Restore brings extracted dir back to `extracted/`
- [ ] Permanent delete removes both files
- [ ] Audit log includes extracted file stats
- [ ] Child session delete also cleans their extracted files
- [ ] Graceful if extracted dir missing (don't fail delete)

---

### SP-09: OpenClaw Logging Integration

**Goal:** Use OpenClaw's logging facility instead of console.

**Levels:**
- `trace`: Start of each function, entry point
- `debug`: File reads, cache hits, mtime checks
- `info`: Config changes, deletes, prunes, restarts, retention cleanup
- `warn`: Hash mismatch on extracted file load, missing but optional files
- `error`: File write failures, permission errors

**Implementation:**
- Import OpenClaw logging utils if exposed to extensions
- Or write to OpenClaw-managed log file directly
- Target: `{openclawRoot}/logs/brainsurgeon.log` or use OpenClaw's main log

**Definition of Done:**
- [ ] No `console.log`/`console.error` in production code
- [ ] All logging goes through OpenClaw facility
- [ ] Debug logs include context: `[DEBUG] loadSession: main/abc123 cache hit`
- [ ] Info logs include actor when available: `[INFO] prune: main/abc123, entries 10, user abc...`

---

## Revised Task Order (No Overlap)

### Step 1: Foundation
1. **SP-01** Config service (runtime config only)
2. **SP-02** Duration parser utility

### Step 2: Extraction Logic
3. **SP-03** Smart prune triggers
4. **SP-05** Directory structure & extraction
5. **SP-06** Session view with extraction support

### Step 3: Automation
6. **SP-04** Auto-trigger cron system

### Step 4: Lifecycle
7. **SP-07** Retention cleanup
8. **SP-08** Delete = full cleanup

### Step 5: Polish
9. **SP-09** OpenClaw logging
10. Web UI settings panel
11. Integration tests

---

## Verification Path for "Indispensable"

**Clean install test:**
```bash
# Fresh OpenClaw, fresh BrainSurgeon
npm install && npm run build
BRAINSURGEON_AGENTS_DIR=/tmp/.openclaw/agents npm start

# No API key set = no auth required
curl http://localhost:8000/api/config  # Should work

# Enable smart pruning
curl -X POST http://localhost:8000/api/config \
  -d '{"enabled":true,"retention":"6h","age_threshold_hours":2}'

# Create large session with thinking blocks
# Wait 2+ min for auto-run
# Verify extracted/ directory created
# Verify old thinking blocks now refs in .jsonl
# Verify Web UI shows extracted badges
# Delete session
# Verify extracted dir moved to trash
# Restore session
# Verify extracted dir back
# Run retention cleanup manually
# Verify old extracted files deleted
```

---

## Key Questions for You

1. **Cron library:** Use `node-cron` (lightweight) or native Node.js scheduler?
2. **Retention schedule:** Add `retention_cron` config or hardcode "every 6 hours"?
3. **Log location:** Should BrainSurgeon have its own `.log` file in `{openclaw}/logs/`, or append to main OpenClaw log?
4. **Hash algorithm:** SHA256 fine, or do you prefer something else for extracted files?

**Ready to implement Step 1 (Config Service) after your confirmation.**
---

## Implementation Notes (Complete)

### Concurrency & Locking

All mutating operations use session-level file locking:
- **Lock file:** `{sessionFile}.lock`
- **Content:** `{"pid": number, "createdAt": "ISOString"}`
- **Stale detection:** 30 minutes
- **Retry:** Exponential backoff (50ms * 2^n), max 30 seconds

**Operations requiring lock:**
- Smart prune extraction
- restore_remote execution
- Session compaction
- Manual entry edit
- Trash restore

### Error Handling

**Missing extracted file on restore:**
- Return placeholder: "[Content unavailable - extracted file missing]"
- Log: `[WARN] Missing extracted file for {entryId}`
- Operation succeeds (graceful degradation)

**Corrupted extracted file:**
- Log: `[ERROR] Corrupted extracted file {path}`
- Return placeholder with error indicator
- Audit log the corruption event

**Extraction failure mid-way:**
- Rollback: restore original session from backup
- Log: `[ERROR] Extraction failed for {session}/{entryId}, rolled back`
- No partial extraction state left

### Orphaned Placeholders

When retention cleanup deletes extracted files:
- Main session may retain `[[extracted]]` placeholders
- This is acceptable degradation
- restore_remote handles missing files gracefully
- Future: optional `/api/sessions/{id}/repair` endpoint to clean up

### Age Calculation (Timestamp Sources)

For `age_threshold_hours` check, try in order:
1. `entry.timestamp` (ISO string or milliseconds)
2. `entry.__ts` (OpenClaw internal)
3. `entry.message?.created_at`
4. `entry.time` (milliseconds)
5. **Fallback:** `entryIndex * 60 * 1000` (estimated 60s per entry)

### Type Detection (for trigger_types)

To match entry against `trigger_types` array:
1. `entry.customType` → "thinking", "model-snapshot", etc.
2. `entry.type` → "message", "tool_call", "tool_result"
3. `entry.message?.role` → "assistant", "user", "system", "tool"
4. `entry.role` → direct role field
5. **Infer:** from content structure (e.g., has "thinking" key = thinking type)

### Extraction Preconditions

Entry is skipped if ANY of:
- Smart pruning disabled (`enabled: false`)
- No `__id` field (can't reference extracted file)
- Already has `[[extracted]]` placeholders (already extracted)
- Type not in `trigger_types` array
- Age < threshold (if `age_threshold_hours > 0`)

### Config Migration

When adding new config fields in future:
- Default values applied on startup if field missing
- Old configs automatically upgraded
- Log: `[INFO] Config upgraded: added field X with default Y`

---

## Ready to Implement

**Foundation tasks (in order):**
1. **SP-01:** Config service (runtime config, no security in response)
2. **SP-02:** Duration parser (`5d`, `6h`, `30m`)
3. **SP-03:** Smart prune triggers + key-level extraction logic
4. **SP-09:** OpenClaw logging integration

**Automation tasks:**
5. **SP-04:** Auto-trigger cron system
6. **SP-07:** Retention cleanup

**Lifecycle tasks:**
7. **SP-05:** Directory structure & extraction
8. **SP-06:** Session view with extraction
9. **SP-08:** Delete = full cleanup

**All design decisions documented. All edge cases covered. 95%+ confidence. Ready to start.**
