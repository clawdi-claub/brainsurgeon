# BrainSurgeon Trigger Enhancement - Test Plan

## Test Matrix

### 1. Config Schema Tests

#### Test 1.1: Valid TriggerRule parsing
**Steps:**
1. POST /config with valid trigger_rules array
2. Each rule has required "type" field
3. Optional fields: min_length, keep_chars, role, keep_recent, custom matchers

**Expected:**
- 200 OK
- Config persisted with all fields
- Generic matchers stored as-is

#### Test 1.2: Invalid TriggerRule (missing type)
**Steps:**
1. POST /config with rule missing "type"

**Expected:**
- 400 Bad Request
- Error: "type is required for each trigger rule"

#### Test 1.3: Invalid numeric ranges
**Steps:**
1. POST /config with min_length: -1
2. POST /config with keep_chars: -5
3. POST /config with keep_recent: -10

**Expected:**
- 400 Bad Request for each
- Error indicates valid range (>= 0)

#### Test 1.4: Backward compatibility migration
**Steps:**
1. POST /config with old format: trigger_types: ["thinking"]
2. GET /config

**Expected:**
- Config accepted
- Auto-migrated to trigger_rules: [{"type": "thinking"}]
- trigger_types removed or deprecated

### 2. Trigger Detection Tests

#### Test 2.1: Type-only matching
**Config:** `[{"type": "thinking", "min_length": 100}]`

**Steps:**
1. Create entry type="thinking", content length=200
2. Run trigger detection

**Expected:**
- Entry matches, flagged for extraction

#### Test 2.2: Role matching (single)
**Config:** `[{"type": "message", "role": "agent"}]`

**Steps:**
1. Create entry type="message", role="agent"
2. Create entry type="message", role="user"

**Expected:**
- Agent entry matches
- User entry does not match

#### Test 2.3: Role matching (OR with |)
**Config:** `[{"type": "message", "role": "user|agent"}]`

**Steps:**
1. Create entry role="user"
2. Create entry role="agent"
3. Create entry role="system"

**Expected:**
- User matches
- Agent matches
- System does not match

#### Test 2.4: Generic key:value matching
**Config:** `[{"type": "tool_result", "toolName": "exec|curl"}]`

**Steps:**
1. Create entry type="tool_result", toolName="exec"
2. Create entry type="tool_result", toolName="curl"
3. Create entry type="tool_result", toolName="ls"

**Expected:**
- exec matches
- curl matches
- ls does not match

#### Test 2.5: Combined matching (type + role + custom)
**Config:** `[{"type": "message", "role": "agent", "customKey": "value1|value2"}]`

**Steps:**
1. Entry matches all criteria
2. Entry matches type+role but not customKey
3. Entry matches type+customKey but wrong role

**Expected:**
- Only #1 matches (all criteria must match)

#### Test 2.6: Min length filtering
**Config:** `[{"type": "message", "min_length": 500}]`

**Steps:**
1. Content length = 400
2. Content length = 500
3. Content length = 600

**Expected:**
- #1: No match (below threshold)
- #2: At threshold = ? (document behavior)
- #3: Match (above threshold)

### 3. keep_chars Truncation Tests

#### Test 3.1: Basic truncation
**Config:** `[{"type": "message", "min_length": 1000, "keep_chars": 100}]`

**Entry:** Content = 1200 chars

**Expected:**
- Entry extracted
- Placeholder: "{first 100 chars}... [[extracted-{entryId}]]"
- Full content in .json file

#### Test 3.2: Content shorter than keep_chars
**Config:** `[{"type": "message", "keep_chars": 100}]`

**Entry:** Content = 50 chars

**Expected:**
- If entry matches other criteria:
  - Full content + "... [[extracted-...]]" (?)
  - Or: No truncation, just placeholder
- Document expected behavior

#### Test 3.3: Unicode/multibyte handling
**Config:** `[{"type": "message", "keep_chars": 10}]`

**Entry:** Content = "日本語テスト content"

**Expected:**
- Proper character counting (not byte count)
- "日本語テスト... [[extracted-...]]"

#### Test 3.4: Restore truncated content

**Steps:**
1. Entry extracted with keep_chars=50
2. Call restore on entry

**Expected:**
- Full content restored (from .json file)
- No truncation in restored content
- _restored timestamp set

### 4. keep_recent Tests

#### Test 4.1: Per-type keep_recent
**Config:**
```json
[
  {"type": "thinking", "keep_recent": 2},
  {"type": "message", "keep_recent": 5}
]
```

**Steps:**
1. Create 10 thinking entries
2. Create 10 message entries

**Expected:**
- Most recent 2 thinking entries NOT extracted (even if long)
- Most recent 5 message entries NOT extracted
- Older entries of both types extracted if criteria met

#### Test 4.2: Mixed keep_recent and extraction
**Config:** `[{"type": "message", "min_length": 100, "keep_recent": 3}]`

**Entries:**
1. Entry 1 (oldest): length=200
2. Entry 2: length=50 (too short)
3. Entry 3: length=200, keep_recent
4. Entry 4: length=200, keep_recent
5. Entry 5: length=200, keep_recent

**Expected:**
- Entry 1: Extracted (meets criteria, not in keep_recent)
- Entry 2: Not extracted (too short)
- Entries 3-5: Not extracted (keep_recent protection)

### 5. Integration / E2E Tests

#### Test 5.1: Full extraction → restore flow
1. Configure complex trigger_rules
2. Create session with matching entries
3. Trigger extraction (manual or auto)
4. Verify entries extracted correctly
5. Call purge_control restore for extracted entry
6. Verify full content restored

#### Test 5.2: Backward compat end-to-end
1. Start with old trigger_types config
2. Verify extraction works
3. Upgrade to trigger_rules
4. Verify extraction still works with migrated config

#### Test 5.3: Live session (readonly=false)
1. Get session lock
2. Try extraction on locked session
3. Verify LockError (expected - gateway holds lock)
4. Release lock
5. Verify extraction succeeds

### 6. WebUI Tests

#### Test 6.1: Config display
**Steps:**
1. Open WebUI
2. Navigate to config/settings
3. View trigger_rules

**Expected:**
- Rules displayed clearly
- All fields visible
- Migration notice if came from trigger_types

#### Test 6.2: Config editing
**Steps:**
1. Edit trigger_rules in WebUI
2. Save changes
3. Verify persisted

**Expected:**
- Changes saved
- Validation errors shown inline
- Success confirmation

#### Test 6.3: Context view with keep_chars
**Steps:**
1. View session with truncated entries
2. Observe entry preview

**Expected:**
- Partial content visible (first keep_chars)
- "..." indicator for truncation
- Extraction badge/indicator

#### Test 6.4: Restore button
**Steps:**
1. View extracted entry
2. Click restore
3. Confirm

**Expected:**
- Full content displayed
- Restore timestamp shown
- UI updates to show restored state

### 7. Edge Cases

#### Test 7.1: Empty content
Entry with empty content, min_length=0

**Expected:**
- Extract if min_length=0 or not specified
- Don't extract if min_length > 0

#### Test 7.2: Null/undefined content
Entry with content=null or undefined

**Expected:**
- Graceful handling
- No extraction (length=0)

#### Test 7.3: Very deep nesting
Nested object with depth > 10

**Expected:**
- Recursion stops at MAX_DEPTH
- No stack overflow
- Partial restore possible

#### Test 7.4: Circular references
Entry with circular object structure

**Expected:**
- JSON.stringify handles gracefully
- No infinite loop

#### Test 7.5: Special characters in content
Content with: `"`, `\n`, `\t`, Unicode, emoji

**Expected:**
- Extraction preserves all characters
- Restore returns identical content

## Run Instructions

### Unit Tests
```bash
cd ts-api
npm test -- trigger-detector.test.ts
npm test -- key-level-extraction.test.ts
npm test -- config-service.test.ts
```

### Integration Tests
```bash
# Start dev environment
docker compose -f docker-compose.dev.yml up -d

# Run E2E
npm test -- extraction-e2e.test.ts
```

### Manual WebUI Tests
```bash
# Open WebUI
open https://brain.lpc.one

# Follow test steps above
```

## Success Criteria

- [ ] All unit tests pass
- [ ] All integration tests pass
- [ ] Manual WebUI tests complete
- [ ] Backward compatibility verified
- [ ] Performance impact measured (< 10% slower trigger detection)
- [ ] Documentation updated
