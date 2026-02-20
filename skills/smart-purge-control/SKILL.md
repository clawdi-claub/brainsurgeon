---
name: smart-purge-control
description: Control BrainSurgeon's smart extraction system. Mark messages as extractable/non-extractable, delay extraction for skill content, and restore extracted values back into context.
metadata: {"openclaw":{"always":true}}
---

# Smart Purge Control

BrainSurgeon automatically extracts large content from older messages to keep sessions lean. This skill tells you how to control what gets extracted and how to get it back.

## How Extraction Works

- Only messages **older than the most recent `keep_recent`** (default: 3) are candidates
- Only `tool_call` and `tool_result` types are extracted by default
- Only values **longer than `min_value_length`** (default: 500 chars) are extracted
- Extracted values are replaced with `[[extracted]]` placeholders

## The `_extractable` Field

Set `_extractable` on any message entry to override default behavior.

| Value | Effect |
|-------|--------|
| `true` | **Force extract** — extract even if wrong type or too short |
| `false` | **Never extract** — stays in context indefinitely |
| `{integer}` | **Custom keep window** — keep for N messages before allowing extraction (overrides global `keep_recent`) |

### When to Use Each

**`_extractable: false`** — Skill content, system prompts, critical reference material that must always be available:
```json
{"_extractable": false, "type": "tool_result", "content": "# Skill: Advanced File Operations\n..."}
```

**`_extractable: 10`** — Content you need for a while but not forever (e.g., a file you just read and are actively working with):
```json
{"_extractable": 10, "type": "tool_result", "output": "<file contents>"}
```

**`_extractable: true`** — Force extraction of something that wouldn't normally qualify (e.g., a small assistant message you want cleaned up):
```json
{"_extractable": true, "type": "message", "message": {"role": "assistant", "content": "short response"}}
```

## Recognizing Extracted Content

When you see `[[extracted]]` in a message value, the original content was extracted to storage. The entry's `__id` (or `id`) is preserved for cross-reference.

Example of an extracted entry:
```json
{"__id": "msg-456", "type": "tool_result", "output": "[[extracted]]"}
```

## Restoring Extracted Content

When you need extracted content back, call the BrainSurgeon restore endpoint:

```
POST /api/sessions/{agentId}/{sessionId}/entries/{entryId}/restore
```

Request body (optional):
```json
{
  "keys": ["content", "output"],
  "toolCallEntryId": "id-of-restore-tool-call"
}
```

- `keys` — restore specific keys only (omit to restore all)
- `toolCallEntryId` — if this restore was triggered by a `restore_remote` tool call, pass that call's entry ID here to redact it

### What Happens on Restore

1. Original values are written back to the session entry
2. The `restore_remote` tool call is redacted to `remote_restore` (hides the restoration from future context)
3. The restored entry is **protected from re-extraction** for `keep_recent` messages

### Re-extraction Protection

After restoration, the entry will NOT be immediately re-extracted. It is protected until `keep_recent` new messages are added to the session. After that, normal extraction rules apply again.

## Using the purge_control Tool

The `purge_control` script provides CLI access to extraction controls:

```bash
# Check context stats
purge_control get_context --agent crix-claub --session direct:123

# Restore extracted content
purge_control restore msg-abc123 --agent crix-claub --session direct:123

# Mark content as never-extractable (for skills, critical refs)
purge_control set_extractable msg-abc123 false --agent crix-claub --session direct:123

# Set custom keep window (keep for 10 messages)
purge_control set_extractable msg-abc123 10 --agent crix-claub --session direct:123
```

## Re-restore Detection

**If you see `[[already-restored]]` instead of `[[extracted]]`:**

This means the content was previously restored and you're trying to restore it again. The content is already in your context — look for the entry with the same ID nearby.

**Prevention:** After restoring content, if you want to ensure it stays available, mark it `_extractable: false`:
```bash
purge_control set_extractable <entry-id> false --agent <agent> --session <session>
```

## Guidelines for Agents

1. **Skill files**: When loading skill content into context, mark it `_extractable: false` so the agent retains access to instructions
2. **Active work files**: Use `_extractable: <N>` with a reasonable N (5–10) for files you're actively editing
3. **One-off lookups**: Let default extraction handle these — they'll be cleaned up automatically
4. **If you see `[[extracted]]` and need the content**: Call the restore endpoint with the entry's `__id`
5. **Don't call restore speculatively** — only restore when you actually need the content for your current task
