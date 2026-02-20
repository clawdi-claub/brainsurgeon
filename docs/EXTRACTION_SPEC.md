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

## Restore Mechanism

When the agent needs extracted content back in context:

### 1. Agent Calls `restore_remote` Tool

```json
{
  "type": "tool_call",
  "name": "restore_remote",
  "arguments": {
    "entry_id": "msg-456",
    "keys": ["content", "output"]
  }
}
```

### 2. System Actions

1. **Restores** the specified keys from extracted storage back to the entry
2. **Redacts** the `restore_remote` tool call to `remote_restore` placeholder
   - Hides the restoration action from future context
   - Redaction enabled by default, disable for debug
3. **Protects** restored value from re-extraction for `keep_recent` messages

### 3. Result in Session File

```json
{
  "type": "tool_call",
  "name": "remote_restore",
  "arguments": null
}
```

The actual `restore_remote` call is replaced with `remote_restore` to prevent the agent from learning the restoration pattern.

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
2. **When to restore:** Call `restore_remote` when you need content that was previously extracted
3. **Restoration behavior:** Restored values will be re-extracted after `keep_recent` more messages
4. **Skill protection:** Important context can be marked `_extractable: false` to stay in memory

---

## Implementation Gaps (Current vs Spec)

| Feature | Spec | Current | Gap |
|---------|------|---------|-----|
| `keep_recent` messages | ✅ Position-based | ❌ `age_threshold_hours` (time-based) | **Major** — wrong mechanism |
| `min_value_length` | ✅ Char threshold | ❌ Not implemented | **Major** — extracts all, not just large |
| `_extractable` override | ✅ `true/false/int` | ❌ Not implemented | **Major** — no per-message control |
| `restore_remote` tool | ✅ Full mechanism | ❌ Not implemented | **Major** — no restoration |
| `remote_restore` redaction | ✅ Enabled by default | ❌ Not implemented | **Major** — agent sees restoration |
| `scan_interval_seconds` | ✅ 30s default | ❌ Cron-based | Minor — timing different |
| Value size logging | ✅ Per-key sizes | ❌ Not implemented | Minor — missing debug info |
| "Only if changed" check | ✅ Optimization | ❌ Not implemented | Minor — scans all sessions |

---

## Configuration Schema (Target)

```typescript
interface ExtractionConfig {
  enabled: boolean;                    // default: true
  keep_recent: number;                 // default: 3 (messages to keep)
  min_value_length: number;            // default: 500 (chars)
  trigger_types: string[];             // default: ['tool_call', 'tool_result']
  scan_interval_seconds: number;       // default: 30
  retention: string;                   // default: '24h'
  redact_restore_calls: boolean;       // default: true
  
  // Advanced
  retention_cron: string;              // default: '0 */6 * * *'
}
```

---

## Migration Path

To align current implementation with spec:

1. **Replace `age_threshold_hours`** with `keep_recent` messages
2. **Add `min_value_length`** filter
3. **Add `_extractable`** field support in trigger detection
4. **Implement `restore_remote` endpoint** that:
   - Reads from ExtractionStorage
   - Updates session entry
   - Redacts the tool call
5. **Add value size logging** to extraction logs
6. **Update UI** to show `_extractable` status and allow editing

---

*Documented: 2026-02-20*
*Status: Specification complete, implementation in progress*
