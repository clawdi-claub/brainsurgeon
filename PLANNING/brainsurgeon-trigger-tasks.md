# BrainSurgeon Extraction Trigger Enhancement Tasks

## Overview
Replace flat trigger_types array with granular per-type trigger rules supporting:
- Per-type min_length, keep_chars, keep_recent
- Role-based filtering (user|agent|*)
- Generic key:value matching with | delimiters
- Backward compatibility with old config format

## Tasks

### 1. Config Schema Updates [medium]
**File:** `ts-api/src/domains/config/model/config.ts`
- [ ] Define `TriggerRule` interface with:
  - type: string (required)
  - min_length?: number
  - keep_chars?: number
  - role?: string (default: "*")
  - keep_recent?: number
  - [key: string]: string | number | undefined (generic matchers)
- [ ] Update `Config` interface: trigger_rules: TriggerRule[]
- [ ] Add default rules migration helper
- [ ] Estimated: 45 min

### 2. Config Validator [medium]
**File:** `ts-api/src/domains/config/service/config-service.ts`
- [ ] Validate each TriggerRule has required 'type'
- [ ] Validate numeric ranges (min_length >= 0, keep_chars >= 0, etc.)
- [ ] Validate role values (user|agent|*)
- [ ] Validate generic matchers don't conflict with reserved keys
- [ ] Backward compat: auto-convert trigger_types[] → trigger_rules[]
- [ ] Estimated: 60 min

### 3. Trigger Detector Rewrite [high]
**File:** `ts-api/src/domains/prune/trigger/trigger-detector.ts`
- [ ] Rewrite detection logic to process rules in priority order
- [ ] Match entry against all rule criteria (type, role, generic key:values)
- [ ] Support | delimiter for OR matching ("user|agent")
- [ ] Handle keep_recent per rule type
- [ ] Estimated: 90 min

### 4. Extraction Service - keep_chars [medium]
**File:** `ts-api/src/domains/prune/extraction/key-level-extraction.ts`
- [ ] Implement preserve-first-N-chars logic
- [ ] Format: "{first_keep_chars}... [[extracted-{entryId}]]"
- [ ] Ensure extracted file has full content
- [ ] Update restore to handle truncated placeholders
- [ ] Estimated: 45 min

### 5. Tests [high]
**Files:** `*.test.ts`
- [ ] Unit tests for new config schema
- [ ] Unit tests for trigger detector with rules
- [ ] Unit tests for keep_chars truncation
- [ ] Integration test: full flow with complex rules
- [ ] Migration test: old config → new config
- [ ] Estimated: 90 min

### 6. API Documentation [low]
**File:** `PLANNING/API.md` or similar
- [ ] Document new /config schema
- [ ] Provide rule examples
- [ ] Document backward compatibility
- [ ] Estimated: 30 min

## Total Estimate: ~6 hours

## Example Configurations

### Current (flat):
```json
{
  "trigger_types": ["thinking", "tool_result"],
  "min_value_length": 500,
  "keep_recent": 3
}
```

### New (per-type rules):
```json
{
  "trigger_rules": [
    {"type": "message", "min_length": 1200, "keep_chars": 75, "role": "agent", "keep_recent": 5},
    {"type": "message", "min_length": 2000, "role": "user", "keep_recent": 3},
    {"type": "tool_result", "min_length": 500, "toolName": "exec|curl", "keep_recent": 2},
    {"type": "thinking", "min_length": 1000, "keep_recent": 2}
  ]
}
```

## Notes
- Gateway restart required after deployment
- Migration should be automatic (trigger_types → trigger_rules)
- Keep_chars prevents "amnesia" by preserving context preview
