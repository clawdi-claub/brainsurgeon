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
- Extracted values are replaced with `[[extracted-${entryId}]]` placeholders (e.g. `[[extracted-msg-456]]`)

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

When you see `[[extracted-<entryId>]]` in a message value, the original content was extracted to storage. The entry ID is embedded in the placeholder for easy identification.

Example of an extracted entry:
```json
{"id": "msg-456", "type": "tool_result", "output": "[[extracted-msg-456]]"}
```

## Restoring Extracted Content

When you need extracted content back, use the `purge_control` tool with action `restore`:

```json
{
  "action": "restore",
  "session": "direct:123",
  "entry": "msg-456",
  "keys": "content,output"
}
```

Or call the BrainSurgeon API directly:

```
POST http://localhost:8000/api/sessions/{agentId}/{sessionId}/entries/{entryId}/restore
```

Request body (optional):
```json
{
  "keys": ["content", "output"]
}
```

- `keys` — restore specific keys only (omit to restore all)

### What Happens on Restore

1. Original values are written back to the session entry
2. The `purge_control` tool call is redacted to prevent cluttering context
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

If you restore content that was already restored, the API will indicate this. The content is already in your context — look for the entry with the same ID nearby.

**Prevention:** After restoring content, if you want to ensure it stays available, mark it `_extractable: false`:
```bash
purge_control set_extractable <entry-id> false --agent <agent> --session <session>
```

## Guidelines for Agents

1. **Skill files**: When loading skill content into context, mark it `_extractable: false` so the agent retains access to instructions
2. **Active work files**: Use `_extractable: <N>` with a reasonable N (5–10) for files you're actively editing
3. **One-off lookups**: Let default extraction handle these — they'll be cleaned up automatically
4. **If you see `[[extracted-<id>]]` and need the content**: Call the restore endpoint with the entry ID from the placeholder
5. **Don't call restore speculatively** — only restore when you actually need the content for your current task
