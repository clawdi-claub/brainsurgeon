# BrainSurgeon Extraction System Specification

**Purpose:** Keep OpenClaw's session files lean by extracting large content to separate storage while preserving conversation flow and context window efficiency.

---

## Core Mechanism: "Keep Recent, Extract Old"

### Basic Setting: `keep_recent = x` (default: 3)

**Rule:** Always keep the most recent `x` messages fully in context. Extract everything before that.

**Example:**
- Session has 10 messages, `keep_recent = 3`
- Messages 0-6 (the 7 older ones) are candidates for extraction
- Messages 7-9 (the 3 most recent) stay fully in context

---

## Trigger Conditions

The extraction job runs:

1. **Every `scan_interval_seconds`** (configurable, default 30s)
2. **Only if session file changed** since last run (optimization)
3. **Within old messages** (before `keep_recent` threshold):
   - Extract values longer than `min_value_length` chars (default 500)
   - Only for configured `trigger_types` (default: `tool_call`, `tool_result`)

---

## Per-Message Override: `_extractable` Field

Messages can control their extractability regardless of type:

| Value | Behavior |
|-------|----------|
| `true` | Force extractable (extract even if wrong type or too short) |
| `false` | Never extract (keep in context indefinitely) |
| `{integer}` | Keep for this many messages (overrides global `keep_recent`) |

### Use Case: Skill Files

Skill content should stay in context so the agent can fully utilize it:

```json
{
  "type": "tool_result",
  "__id": "msg-123",
  "message": {
    "role": "tool",
    "content": "# Skill: Advanced File Operations\n\n## API... [5000 chars]"
  },
  "_extractable": false
}
```

This skill file will never be extracted, ensuring the agent always has full context.

---

## Placeholder Format

When content is extracted, the value is replaced with:

```
[[extracted-${entryId}]]
```

**Example:**
```json
{
  "type": "tool_result",
  "__id": "msg-456",
  "output": "[[extracted-msg-456]]"
}
```

The entry ID in the placeholder allows agents to identify exactly which entry to restore without needing prior context.

## Restore Mechanism

When the agent needs extracted content back in context:

### 1. Agent Calls `restore` Tool

```json
{
  "type": "tool_call",
  "name": "restore",
  "arguments": {
    "entry_id": "msg-456",
    "keys": ["content", "output"]
  }
}
```

### 2. System Actions

1. **Restores** the specified keys from extracted storage back to the entry
2. **Records** restoration timestamp: `_restored: "2026-02-20T17:30:00Z"`
3. **Redacts** the `purge_control` tool call to prevent cluttering context
   - Hides the restoration action from future context
   - Redaction enabled by default (config: `keep_restore_calls`)
4. **Protects** restored value from re-extraction for `keep_after_restore_seconds` (default: 10 minutes)

### 3. Time-Based Re-extraction Protection

Unlike the position-based `keep_recent`, restored entries are protected by **time**:

```typescript
if (entry._restored) {
  const restoredAt = new Date(entry._restored).getTime();
  const protectedUntil = restoredAt + (config.keep_after_restore_seconds * 1000);
  if (Date.now() < protectedUntil) {
    skip_extraction(); // Still within protection window
  }
}
```

**Default:** `keep_after_restore_seconds = 600` (10 minutes)

This prevents the "extract→restore→extract→restore" infinite loop while allowing content to be eventually cleaned up after the working session ends.

### 4. Re-Restoring Already-Restored Entries

The `_restored` field **persists** even if the entry is later re-extracted. When an agent attempts to restore an entry that already has `_restored`:

**System response:**
```json
{
  "restored": true,
  "entry_id": "msg-456",
  "keys_restored": ["content"],
  "previous_restored_at": "2026-02-20T17:30:00Z",
  "suggestion": "This entry was previously restored. If you need to keep this content long-term, consider setting _extractable: false on the entry."
}
```

This guidance helps agents avoid repeated restore cycles for content they actually need.

### 5. Result in Session File

After restoration and redaction:
```json
{
  "type": "tool_call",
  "name": "purge_control",
  "arguments": {"action": "restore", "entry": "msg-456"},
  "_redacted": true
}
```

The actual `purge_control` call is marked with `_redacted` to prevent cluttering context.

---

## Logging Requirements

Every extraction and restoration must be debug-logged with:

### Extraction Log
```
level: debug
module: extraction
entry_id: "msg-123"
keys_extracted: ["content", "output"]
sizes_bytes: {"content": 4520, "output": 8900}
session: "agent-id/session-id"
```

### Restoration Log
```
level: debug
module: extraction
entry_id: "msg-123"
keys_restored: ["content", "output"]
sizes_bytes: {"content": 4520, "output": 8900}
redacted: true
session: "agent-id/session-id"
```

**Purpose:** Enable debugging and fine-tuning by analyzing which keys are frequently extracted/restored.

---

## Agent Instructions

Agents using BrainSurgeon extraction need to be instructed on:

1. **What gets extracted:** Large tool results/thinking blocks older than `keep_recent` messages
2. **When to restore:** Call `purge_control` with action `restore` when you need content that was previously extracted
3. **Restoration behavior:** Restored values will be re-extracted after `keep_recent` more messages
4. **Skill protection:** Important context can be marked `_extractable: false` to stay in memory

---

## Implementation Status

| Feature | Spec | Status | Notes |
|---------|------|--------|-------|
| `keep_recent` messages | ✅ Position-based | ✅ Implemented | `positionFromEnd >= keep_recent` |
| `min_value_length` | ✅ Char threshold | ✅ Implemented | Checks content, text, output, result, data, thinking, message |
| `_extractable` override | ✅ `true/false/int` | ✅ Implemented | Force, prevent, or custom keep window |
| Placeholder format | `[[extracted-${entryId}]]` | ⚠️ **TODO** | Currently `[[extracted]]` — needs entry ID |
| `restore` tool | ✅ Full mechanism | ⚠️ **TODO** | Needs agent-callable tool, not just REST API |
| `purge_control` redaction | ✅ Enabled by default | ✅ Implemented | `keep_purge_control_calls: false` |
| Time-based restore protection | `_restored` + `keep_after_restore_seconds` | ⚠️ **TODO** | Currently position-based, needs time-based |
| Re-restore guidance | Suggest `_extractable: false` | ⚠️ **TODO** | Needs detection logic + response field |
| Value size logging | ✅ Per-key sizes | ✅ Implemented | `sizesBytes` in extraction + restore results |
| "Only if changed" check | ✅ Optimization | ❌ Not implemented | Minor optimization — scans all sessions |

---

## Configuration Schema

```typescript
interface SmartPruningConfig {
  enabled: boolean;                    // default: true
  keep_recent: number;                 // default: 3 (messages to keep)
  min_value_length: number;            // default: 500 (chars)
  trigger_types: string[];             // default: ['thinking', 'tool_result']
  scan_interval_seconds: number;       // default: 30
  retention: string;                   // default: '24h'
  
  // Restore/Redaction
  keep_purge_control_calls: boolean;  // default: false (redact by default)
  keep_after_restore_seconds: number;  // default: 600 (10 minutes)
  
  // Cron schedules
  auto_cron: string;                   // default: '*/2 * * * *'
  retention_cron: string;              // default: '0 */6 * * *'
  
  // Runtime tracking
  last_run_at: string | null;
  last_retention_run_at: string | null;
}
```

---

## Remaining Work

### Phase 1: Placeholder Format (kb-???)
- Replace `[[extracted]]` with `[[extracted-${entryId}]]`
- Entry ID must be URL-safe and match the `__id` field

### Phase 2: Time-Based Restore Protection (kb-???)
- Replace `_restored_at_position` with `_restored` timestamp
- Add `keep_after_restore_seconds` config (default: 600)
- Update trigger detector to check time difference, not position
- Add UI config field for "Keep after restore (seconds)"

### Phase 3: Agent Tools (kb-???)
- Create `purge_control` tool with actions:
  - `get_context` → session info + extracted entries list
  - `restore` → restore by entry_id
  - `set_extractable` → set _extractable on entry

### Phase 4: Re-Restore Guidance (kb-???)
- Detect when restoring entry that already has `_restored`
- Return suggestion in response: "consider setting _extractable: false"

### Phase 5: Skill Update (kb-???)
- Update smart-purge-control skill with:
  - New placeholder format
  - Tool usage instructions
  - Re-extraction guidance

## Test Cases: Time-Based Restore Protection

### Test 1: Freshly Restored Entry Protected
**Given:**
- Entry was restored 5 minutes ago
- `keep_after_restore_seconds = 600` (10 min)

**When:** Extraction job runs

**Then:** Entry is NOT extracted (still within 10 min window)

---

### Test 2: Expired Protection Allows Extraction
**Given:**
- Entry was restored 15 minutes ago
- `keep_after_restore_seconds = 600` (10 min)

**When:** Extraction job runs

**Then:** Entry IS extracted (15 min > 10 min)

---

### Test 3: Custom Protection Duration
**Given:**
- Entry was restored 30 seconds ago
- `keep_after_restore_seconds = 30` (30 sec)

**When:** Extraction job runs

**Then:** Entry IS extracted (30 sec >= 30 sec boundary)

---

### Test 4: Re-Restore Detection
**Given:**
- Entry has `_restored: "2026-02-20T10:00:00Z"` (already restored once)
- Content was later re-extracted

**When:** Agent calls restore again

**Then:** 
- Restore succeeds
- Response includes: `"previous_restored_at": "2026-02-20T10:00:00Z"`
- Response includes: `"suggestion": "consider setting _extractable: false"`

---

### Test 5: _extractable Override Bypasses Time Protection
**Given:**
- Entry was restored 1 minute ago
- Entry has `_extractable: true`

**When:** Extraction job runs

**Then:** Entry IS extracted immediately (force override wins)

---

### Test 6: _extractable: false Prevents All Extraction
**Given:**
- Entry was restored 1 hour ago (well past protection)
- Entry has `_extractable: false`

**When:** Extraction job runs

**Then:** Entry is NOT extracted (false wins over expired protection)

---

*Documented: 2026-02-20*
*Updated: 2026-02-20*
*Status: Core implemented, remaining: placeholder format, time-based protection, agent tools*
