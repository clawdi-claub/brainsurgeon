import { describe, it, expect } from 'vitest';
import { detectTrigger, type SessionEntry, type TriggerConfig } from './trigger-detector.js';

describe('detectTrigger (rule-based)', () => {
  const baseConfig: TriggerConfig = {
    enabled: true,
    trigger_rules: [
      { type: 'thinking', min_length: 500, keep_recent: 3 },
      { type: 'tool_result', min_length: 500, keep_recent: 3 },
    ],
    keep_recent: 3,
    min_value_length: 500,
    keep_after_restore_seconds: 600,
  };

  it('returns no match when disabled', () => {
    const entry: SessionEntry = {
      __id: 'ent_001',
      customType: 'thinking',
      thinking: 'a'.repeat(600),
    };

    const result = detectTrigger(entry, { ...baseConfig, enabled: false }, 5);

    expect(result.matched).toBe(false);
    expect(result.shouldExtract).toBe(false);
    expect(result.skipReason).toBe('smart_pruning_disabled');
  });

  it('matches thinking entries with large content', () => {
    const entry: SessionEntry = {
      __id: 'ent_001',
      customType: 'thinking',
      thinking: 'a'.repeat(600),
    };

    const result = detectTrigger(entry, baseConfig, 5);

    expect(result.matched).toBe(true);
    expect(result.triggerType).toBe('thinking');
    expect(result.hasId).toBe(true);
    expect(result.meetsPositionThreshold).toBe(true);
    expect(result.shouldExtract).toBe(true);
    expect(result.matchedRule).toBeDefined();
    expect(result.matchedRule!.type).toBe('thinking');
  });

  it('matches tool_result entries with large content', () => {
    const entry: SessionEntry = {
      __id: 'ent_002',
      type: 'tool_result',
      output: 'a'.repeat(600),
    };

    const result = detectTrigger(entry, baseConfig, 5);

    expect(result.matched).toBe(true);
    expect(result.triggerType).toBe('tool_result');
    expect(result.shouldExtract).toBe(true);
  });

  it('accepts entries with id field (OpenClaw format)', () => {
    const entry: SessionEntry = {
      id: 'ent_022',
      customType: 'thinking',
      thinking: 'a'.repeat(600),
    };

    const result = detectTrigger(entry, baseConfig, 5);

    expect(result.matched).toBe(true);
    expect(result.hasId).toBe(true);
    expect(result.shouldExtract).toBe(true);
  });

  it('prefers __id over id when both present', () => {
    const entry: SessionEntry = {
      __id: 'preferred_id',
      id: 'secondary_id',
      customType: 'thinking',
      thinking: 'a'.repeat(600),
    };

    const result = detectTrigger(entry, baseConfig, 5);

    expect(result.matched).toBe(true);
    expect(result.hasId).toBe(true);
  });

  it('rejects entries with [[extracted-${entryId}]] placeholders', () => {
    const entry: SessionEntry = {
      __id: 'ent_003',
      customType: 'thinking',
      thinking: '[[extracted-ent_003]]',
    };

    const result = detectTrigger(entry, baseConfig, 5);

    expect(result.matched).toBe(false);
    expect(result.shouldExtract).toBe(false);
    expect(result.skipReason).toBe('already_extracted');
  });

  it('respects keep_recent threshold', () => {
    const entry: SessionEntry = {
      __id: 'ent_004',
      customType: 'thinking',
      thinking: 'a'.repeat(600),
    };

    const result = detectTrigger(entry, baseConfig, 1);

    expect(result.matched).toBe(true);
    expect(result.meetsPositionThreshold).toBe(false);
    expect(result.shouldExtract).toBe(false);
    expect(result.skipReason).toBe('too_recent');
  });

  it('extracts when position equals keep_recent', () => {
    const entry: SessionEntry = {
      __id: 'ent_005',
      customType: 'thinking',
      thinking: 'a'.repeat(600),
    };

    const result = detectTrigger(entry, baseConfig, 3);

    expect(result.matched).toBe(true);
    expect(result.meetsPositionThreshold).toBe(true);
    expect(result.shouldExtract).toBe(true);
  });

  it('respects min_value_length threshold', () => {
    const entry: SessionEntry = {
      __id: 'ent_006',
      customType: 'thinking',
      thinking: 'short',
    };

    const result = detectTrigger(entry, baseConfig, 5);

    expect(result.matched).toBe(true);
    expect(result.meetsPositionThreshold).toBe(true);
    expect(result.shouldExtract).toBe(false);
    expect(result.skipReason).toBe('values_too_small');
  });

  it('extracts all positions when keep_recent is 0', () => {
    const entry: SessionEntry = {
      __id: 'ent_007',
      customType: 'thinking',
      thinking: 'a'.repeat(600),
    };

    const config: TriggerConfig = {
      ...baseConfig,
      trigger_rules: [
        { type: 'thinking', min_length: 500, keep_recent: 0 },
      ],
      keep_recent: 0,
    };

    const result = detectTrigger(entry, config, 0);

    expect(result.matched).toBe(true);
    expect(result.meetsPositionThreshold).toBe(true);
    expect(result.shouldExtract).toBe(true);
  });

  it('detects type from message.role', () => {
    const entry: SessionEntry = {
      __id: 'ent_008',
      type: 'message',
      message: { role: 'assistant' },
      content: 'a'.repeat(600),
    };

    const config: TriggerConfig = {
      ...baseConfig,
      trigger_rules: [{ type: 'assistant', min_length: 500, keep_recent: 3 }],
    };

    const result = detectTrigger(entry, config, 5);

    expect(result.matched).toBe(true);
    expect(result.triggerType).toBe('assistant');
  });

  it('detects type from entry.role', () => {
    const entry: SessionEntry = {
      __id: 'ent_009',
      role: 'system',
      content: 'a'.repeat(600),
    };

    const config: TriggerConfig = {
      ...baseConfig,
      trigger_rules: [{ type: 'system', min_length: 500, keep_recent: 3 }],
    };

    const result = detectTrigger(entry, config, 5);

    expect(result.matched).toBe(true);
    expect(result.triggerType).toBe('system');
  });

  it('infers thinking type from content structure', () => {
    const entry: SessionEntry = {
      __id: 'ent_010',
      data: { thinking: 'a'.repeat(600) },
    };

    const result = detectTrigger(entry, baseConfig, 5);

    expect(result.matched).toBe(true);
    expect(result.triggerType).toBe('thinking');
  });

  it('only matches configured trigger rules', () => {
    const entry: SessionEntry = {
      __id: 'ent_011',
      type: 'message',
      message: { role: 'user' },
      content: 'a'.repeat(600),
    };

    // No rule for 'user' type
    const result = detectTrigger(entry, baseConfig, 5);

    expect(result.matched).toBe(false);
    expect(result.shouldExtract).toBe(false);
    expect(result.skipReason).toBe('type_not_matched');
  });

  describe('_extractable override', () => {
    it('forces extraction when _extractable: true', () => {
      const entry: SessionEntry = {
        __id: 'ent_012',
        type: 'message',
        message: { role: 'user' },
        content: 'a'.repeat(600),
        _extractable: true,
      };

      const result = detectTrigger(entry, baseConfig, 1);

      expect(result.matched).toBe(true);
      expect(result.shouldExtract).toBe(true);
    });

    it('forces extraction when _extractable: true even with small values', () => {
      const entry: SessionEntry = {
        __id: 'ent_012b',
        type: 'message',
        message: { role: 'user' },
        content: 'tiny',
        _extractable: true,
      };

      const result = detectTrigger(entry, baseConfig, 5);

      expect(result.matched).toBe(true);
      expect(result.shouldExtract).toBe(true);
    });

    it('prevents extraction when _extractable: false', () => {
      const entry: SessionEntry = {
        __id: 'ent_013',
        customType: 'thinking',
        thinking: 'a'.repeat(600),
        _extractable: false,
      };

      const result = detectTrigger(entry, baseConfig, 5);

      expect(result.matched).toBe(false);
      expect(result.shouldExtract).toBe(false);
      expect(result.skipReason).toBe('_extractable_false');
    });

    it('uses integer _extractable to override keep_recent', () => {
      const entry: SessionEntry = {
        __id: 'ent_014',
        customType: 'thinking',
        thinking: 'a'.repeat(600),
        _extractable: 10,
      };

      const result = detectTrigger(entry, baseConfig, 5);

      expect(result.matched).toBe(false);
      expect(result.shouldExtract).toBe(false);
      expect(result.skipReason).toBe('_extractable_false');
    });

    it('allows extraction after integer _extractable threshold', () => {
      const entry: SessionEntry = {
        __id: 'ent_015',
        customType: 'thinking',
        thinking: 'a'.repeat(600),
        _extractable: 5,
      };

      const result = detectTrigger(entry, baseConfig, 10);

      expect(result.matched).toBe(true);
      expect(result.shouldExtract).toBe(true);
    });
  });

  describe('re-extraction protection (_restored time-based)', () => {
    it('prevents extraction of recently restored entries', () => {
      const entry: SessionEntry = {
        __id: 'ent_030',
        customType: 'thinking',
        thinking: 'a'.repeat(600),
        _restored: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      };

      const result = detectTrigger(entry, baseConfig, 5);

      expect(result.shouldExtract).toBe(false);
      expect(result.skipReason).toContain('recently_restored');
      expect(result.skipReason).toContain('remaining');
    });

    it('allows extraction after protection expires', () => {
      const entry: SessionEntry = {
        __id: 'ent_031',
        customType: 'thinking',
        thinking: 'a'.repeat(600),
        _restored: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
      };

      const result = detectTrigger(entry, baseConfig, 5);

      expect(result.shouldExtract).toBe(true);
    });

    it('protection uses keep_after_restore_seconds from config', () => {
      const entry: SessionEntry = {
        __id: 'ent_032',
        customType: 'thinking',
        thinking: 'a'.repeat(600),
        _restored: new Date(Date.now() - 20 * 1000).toISOString(),
      };

      const configShort: TriggerConfig = { ...baseConfig, keep_after_restore_seconds: 30 };
      const result1 = detectTrigger(entry, configShort, 5);
      expect(result1.shouldExtract).toBe(false);

      const configVeryShort: TriggerConfig = { ...baseConfig, keep_after_restore_seconds: 10 };
      const result2 = detectTrigger(entry, configVeryShort, 5);
      expect(result2.shouldExtract).toBe(true);
    });

    it('_extractable: true overrides time-based restoration protection', () => {
      const entry: SessionEntry = {
        __id: 'ent_033',
        customType: 'thinking',
        thinking: 'a'.repeat(600),
        _extractable: true,
        _restored: new Date(Date.now() - 5 * 1000).toISOString(),
      };

      const result = detectTrigger(entry, baseConfig, 5);

      expect(result.shouldExtract).toBe(true);
    });

    it('_extractable: false overrides restoration protection (still prevents)', () => {
      const entry: SessionEntry = {
        __id: 'ent_034',
        customType: 'thinking',
        thinking: 'a'.repeat(600),
        _extractable: false,
        _restored: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
      };

      const result = detectTrigger(entry, baseConfig, 5);

      expect(result.shouldExtract).toBe(false);
      expect(result.skipReason).toBe('_extractable_false');
    });
  });

  describe('value size checking', () => {
    it('checks content field length', () => {
      const entry: SessionEntry = {
        __id: 'ent_016',
        customType: 'thinking',
        content: 'a'.repeat(600),
      };

      const result = detectTrigger(entry, baseConfig, 5);

      expect(result.matched).toBe(true);
      expect(result.shouldExtract).toBe(true);
    });

    it('checks text field length', () => {
      const entry: SessionEntry = {
        __id: 'ent_017',
        customType: 'thinking',
        text: 'a'.repeat(600),
      };

      const result = detectTrigger(entry, baseConfig, 5);

      expect(result.matched).toBe(true);
      expect(result.shouldExtract).toBe(true);
    });

    it('checks output field length', () => {
      const entry: SessionEntry = {
        __id: 'ent_018',
        type: 'tool_result',
        output: 'a'.repeat(600),
      };

      const result = detectTrigger(entry, baseConfig, 5);

      expect(result.matched).toBe(true);
      expect(result.shouldExtract).toBe(true);
    });

    it('checks message.content length', () => {
      const entry: SessionEntry = {
        __id: 'ent_019',
        type: 'message',
        message: { role: 'assistant', content: 'a'.repeat(600) },
      };

      const config: TriggerConfig = {
        ...baseConfig,
        trigger_rules: [{ type: 'assistant', min_length: 500, keep_recent: 3 }],
      };

      const result = detectTrigger(entry, config, 5);

      expect(result.matched).toBe(true);
      expect(result.shouldExtract).toBe(true);
    });

    it('rejects when all content is too small', () => {
      const entry: SessionEntry = {
        __id: 'ent_020',
        customType: 'thinking',
        thinking: 'short',
        content: 'tiny',
        text: 'small',
      };

      const result = detectTrigger(entry, baseConfig, 5);

      expect(result.matched).toBe(true);
      expect(result.shouldExtract).toBe(false);
      expect(result.skipReason).toBe('values_too_small');
    });

    it('extracts when object content is large', () => {
      const entry: SessionEntry = {
        __id: 'ent_021',
        type: 'tool_result',
        data: { nested: 'a'.repeat(600) },
      };

      const result = detectTrigger(entry, baseConfig, 5);

      expect(result.matched).toBe(true);
      expect(result.shouldExtract).toBe(true);
    });
  });

  describe('role-based matching', () => {
    it('matches rule with specific role', () => {
      const entry: SessionEntry = {
        __id: 'ent_040',
        type: 'message',
        message: { role: 'assistant' },
        content: 'a'.repeat(600),
      };

      const config: TriggerConfig = {
        ...baseConfig,
        trigger_rules: [
          { type: 'assistant', role: 'assistant', min_length: 500, keep_recent: 3 },
        ],
      };

      const result = detectTrigger(entry, config, 5);
      expect(result.matched).toBe(true);
      expect(result.shouldExtract).toBe(true);
    });

    it('rejects when role does not match', () => {
      const entry: SessionEntry = {
        __id: 'ent_041',
        type: 'message',
        message: { role: 'user' },
        content: 'a'.repeat(600),
      };

      const config: TriggerConfig = {
        ...baseConfig,
        trigger_rules: [
          { type: 'user', role: 'assistant', min_length: 500, keep_recent: 3 },
        ],
      };

      const result = detectTrigger(entry, config, 5);
      expect(result.matched).toBe(false);
      expect(result.skipReason).toBe('type_not_matched');
    });

    it('matches pipe-delimited role (user|agent)', () => {
      const userEntry: SessionEntry = {
        __id: 'ent_042a',
        type: 'message',
        message: { role: 'user' },
        content: 'a'.repeat(600),
      };

      const assistantEntry: SessionEntry = {
        __id: 'ent_042b',
        type: 'message',
        message: { role: 'assistant' },
        content: 'a'.repeat(600),
      };

      const systemEntry: SessionEntry = {
        __id: 'ent_042c',
        type: 'message',
        message: { role: 'system' },
        content: 'a'.repeat(600),
      };

      const config: TriggerConfig = {
        ...baseConfig,
        trigger_rules: [
          { type: 'user', role: 'user|assistant', min_length: 500, keep_recent: 3 },
          { type: 'assistant', role: 'user|assistant', min_length: 500, keep_recent: 3 },
          { type: 'system', role: 'user|assistant', min_length: 500, keep_recent: 3 },
        ],
      };

      expect(detectTrigger(userEntry, config, 5).shouldExtract).toBe(true);
      expect(detectTrigger(assistantEntry, config, 5).shouldExtract).toBe(true);
      expect(detectTrigger(systemEntry, config, 5).shouldExtract).toBe(false);
    });

    it('wildcard role matches all', () => {
      const entry: SessionEntry = {
        __id: 'ent_043',
        customType: 'thinking',
        thinking: 'a'.repeat(600),
      };

      const config: TriggerConfig = {
        ...baseConfig,
        trigger_rules: [
          { type: 'thinking', role: '*', min_length: 500, keep_recent: 3 },
        ],
      };

      const result = detectTrigger(entry, config, 5);
      expect(result.shouldExtract).toBe(true);
    });
  });

  describe('generic key:value matchers', () => {
    it('matches toolName from entry', () => {
      const entry: SessionEntry = {
        __id: 'ent_050',
        type: 'tool_result',
        toolName: 'exec',
        output: 'a'.repeat(600),
      };

      const config: TriggerConfig = {
        ...baseConfig,
        trigger_rules: [
          { type: 'tool_result', toolName: 'exec|curl', min_length: 500, keep_recent: 2 },
        ],
      };

      const result = detectTrigger(entry, config, 5);
      expect(result.matched).toBe(true);
      expect(result.shouldExtract).toBe(true);
    });

    it('rejects when toolName does not match pattern', () => {
      const entry: SessionEntry = {
        __id: 'ent_051',
        type: 'tool_result',
        toolName: 'ls',
        output: 'a'.repeat(600),
      };

      const config: TriggerConfig = {
        ...baseConfig,
        trigger_rules: [
          { type: 'tool_result', toolName: 'exec|curl', min_length: 500, keep_recent: 2 },
        ],
      };

      const result = detectTrigger(entry, config, 5);
      expect(result.matched).toBe(false);
      expect(result.skipReason).toBe('type_not_matched');
    });

    it('all generic matchers must match (AND logic)', () => {
      const entry: SessionEntry = {
        __id: 'ent_052',
        type: 'tool_result',
        toolName: 'exec',
        provider: 'local',
        output: 'a'.repeat(600),
      };

      const config: TriggerConfig = {
        ...baseConfig,
        trigger_rules: [
          { type: 'tool_result', toolName: 'exec', provider: 'remote', min_length: 500, keep_recent: 2 },
        ],
      };

      const result = detectTrigger(entry, config, 5);
      expect(result.matched).toBe(false);
      expect(result.skipReason).toBe('type_not_matched');
    });
  });

  describe('per-rule keep_recent', () => {
    it('uses rule-level keep_recent instead of global', () => {
      const entry: SessionEntry = {
        __id: 'ent_060',
        customType: 'thinking',
        thinking: 'a'.repeat(600),
      };

      const config: TriggerConfig = {
        ...baseConfig,
        trigger_rules: [
          { type: 'thinking', min_length: 500, keep_recent: 8 },
        ],
        keep_recent: 3, // global is 3 but rule says 8
      };

      // Position 5: global would allow (5 >= 3) but rule prevents (5 < 8)
      const result = detectTrigger(entry, config, 5);
      expect(result.shouldExtract).toBe(false);
      expect(result.skipReason).toBe('too_recent');

      // Position 10: rule allows (10 >= 8)
      const result2 = detectTrigger(entry, config, 10);
      expect(result2.shouldExtract).toBe(true);
    });

    it('falls back to global keep_recent when rule omits it', () => {
      const entry: SessionEntry = {
        __id: 'ent_061',
        customType: 'thinking',
        thinking: 'a'.repeat(600),
      };

      const config: TriggerConfig = {
        ...baseConfig,
        trigger_rules: [
          { type: 'thinking', min_length: 500 }, // no keep_recent
        ],
        keep_recent: 3,
      };

      // Position 2: below global keep_recent
      const result1 = detectTrigger(entry, config, 2);
      expect(result1.shouldExtract).toBe(false);
      expect(result1.skipReason).toBe('too_recent');

      // Position 4: above global keep_recent
      const result2 = detectTrigger(entry, config, 4);
      expect(result2.shouldExtract).toBe(true);
    });
  });

  describe('per-rule min_length', () => {
    it('uses rule-level min_length instead of global', () => {
      const entry: SessionEntry = {
        __id: 'ent_070',
        customType: 'thinking',
        thinking: 'a'.repeat(1500),
      };

      const config: TriggerConfig = {
        ...baseConfig,
        trigger_rules: [
          { type: 'thinking', min_length: 2000, keep_recent: 3 },
        ],
        min_value_length: 500, // global is 500 but rule says 2000
      };

      // 1500 chars: global would allow but rule prevents
      const result = detectTrigger(entry, config, 5);
      expect(result.shouldExtract).toBe(false);
      expect(result.skipReason).toBe('values_too_small');
    });

    it('falls back to global min_value_length when rule omits it', () => {
      const entry: SessionEntry = {
        __id: 'ent_071',
        customType: 'thinking',
        thinking: 'a'.repeat(600),
      };

      const config: TriggerConfig = {
        ...baseConfig,
        trigger_rules: [
          { type: 'thinking', keep_recent: 3 }, // no min_length
        ],
        min_value_length: 500,
      };

      const result = detectTrigger(entry, config, 5);
      expect(result.shouldExtract).toBe(true);
    });
  });

  describe('rule priority (first match wins)', () => {
    it('uses first matching rule', () => {
      const entry: SessionEntry = {
        __id: 'ent_080',
        type: 'tool_result',
        toolName: 'exec',
        output: 'a'.repeat(800),
      };

      const config: TriggerConfig = {
        ...baseConfig,
        trigger_rules: [
          // Rule 1: exec tools, keep_recent=5
          { type: 'tool_result', toolName: 'exec', min_length: 500, keep_recent: 5 },
          // Rule 2: all tool_results, keep_recent=2
          { type: 'tool_result', min_length: 500, keep_recent: 2 },
        ],
      };

      // Position 3: first rule prevents (3 < 5), second would allow (3 >= 2)
      // But first rule wins
      const result = detectTrigger(entry, config, 3);
      expect(result.shouldExtract).toBe(false);
      expect(result.skipReason).toBe('too_recent');
    });

    it('falls through to next rule when generic matcher fails', () => {
      const entry: SessionEntry = {
        __id: 'ent_081',
        type: 'tool_result',
        toolName: 'ls',
        output: 'a'.repeat(800),
      };

      const config: TriggerConfig = {
        ...baseConfig,
        trigger_rules: [
          // Rule 1: exec only — won't match ls
          { type: 'tool_result', toolName: 'exec', min_length: 500, keep_recent: 5 },
          // Rule 2: all tool_results
          { type: 'tool_result', min_length: 500, keep_recent: 2 },
        ],
      };

      // toolName=ls doesn't match rule 1, falls to rule 2
      const result = detectTrigger(entry, config, 3);
      expect(result.shouldExtract).toBe(true);
    });
  });

  describe('matchedRule in result', () => {
    it('carries matched rule for downstream use (keep_chars)', () => {
      const entry: SessionEntry = {
        __id: 'ent_090',
        customType: 'thinking',
        thinking: 'a'.repeat(1200),
      };

      const config: TriggerConfig = {
        ...baseConfig,
        trigger_rules: [
          { type: 'thinking', min_length: 1000, keep_chars: 75, keep_recent: 3 },
        ],
      };

      const result = detectTrigger(entry, config, 5);
      expect(result.shouldExtract).toBe(true);
      expect(result.matchedRule).toBeDefined();
      expect(result.matchedRule!.keep_chars).toBe(75);
    });
  });
});
