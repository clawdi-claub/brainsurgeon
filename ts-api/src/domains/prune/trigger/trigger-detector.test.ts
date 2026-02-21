import { describe, it, expect } from 'vitest';
import { detectTrigger, type SessionEntry, type TriggerConfig } from './trigger-detector.js';

describe('detectTrigger (position-based)', () => {
  const baseConfig: TriggerConfig = {
    enabled: true,
    trigger_types: ['thinking', 'tool_result'],
    keep_recent: 3,
    min_value_length: 500,
    keep_after_restore_seconds: 600, // 10 minutes default
  };

  it('returns no match when disabled', () => {
    const entry: SessionEntry = {
      __id: 'ent_001',
      customType: 'thinking',
      thinking: 'some reasoning that is long enough to be extracted because it exceeds the minimum length requirement',
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
      thinking: 'a'.repeat(600), // Exceeds min_value_length
    };

    // Position 5 from end means it's old enough to extract (keep_recent=3)
    const result = detectTrigger(entry, baseConfig, 5);

    expect(result.matched).toBe(true);
    expect(result.triggerType).toBe('thinking');
    expect(result.hasId).toBe(true);
    expect(result.meetsPositionThreshold).toBe(true);
    expect(result.shouldExtract).toBe(true);
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
      id: 'ent_022',  // OpenClaw uses 'id' not '__id'
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

    // Position 1 from end (too recent, within keep_recent=3)
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

    // Position 3 from end (equals keep_recent, should extract)
    const result = detectTrigger(entry, baseConfig, 3);

    expect(result.matched).toBe(true);
    expect(result.meetsPositionThreshold).toBe(true);
    expect(result.shouldExtract).toBe(true);
  });

  it('respects min_value_length threshold', () => {
    const entry: SessionEntry = {
      __id: 'ent_006',
      customType: 'thinking',
      thinking: 'short', // Less than 500 chars
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

    // Even position 0 should extract when keep_recent=0
    const result = detectTrigger(entry, { ...baseConfig, keep_recent: 0 }, 0);

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
      trigger_types: ['assistant'],
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
      trigger_types: ['system'],
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

  it('only matches configured trigger_types', () => {
    const entry: SessionEntry = {
      __id: 'ent_011',
      type: 'message',
      message: { role: 'user' },
      content: 'a'.repeat(600),
    };

    // user not in trigger_types
    const result = detectTrigger(entry, baseConfig, 5);

    expect(result.matched).toBe(false);
    expect(result.shouldExtract).toBe(false);
    expect(result.skipReason).toBe('type_not_matched');
  });

  describe('_extractable override', () => {
    it('forces extraction when _extractable: true', () => {
      const entry: SessionEntry = {
        __id: 'ent_012',
        type: 'message', // Not in trigger_types
        message: { role: 'user' },
        content: 'a'.repeat(600),
        _extractable: true,
      };

      const result = detectTrigger(entry, baseConfig, 1); // Would be too recent

      expect(result.matched).toBe(true);
      expect(result.shouldExtract).toBe(true);
    });

    it('forces extraction when _extractable: true even with small values', () => {
      const entry: SessionEntry = {
        __id: 'ent_012b',
        type: 'message',
        message: { role: 'user' },
        content: 'tiny', // Way below min_value_length
        _extractable: true,
      };

      const result = detectTrigger(entry, baseConfig, 5);

      expect(result.matched).toBe(true);
      expect(result.shouldExtract).toBe(true);
      // Spec: "_extractable: true → extract even if wrong type or too short"
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
        _extractable: 10, // Keep for 10 messages
      };

      // Position 5 would normally be extracted (keep_recent=3)
      // But _extractable=10 means keep for 10 messages
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

      // Position 10 exceeds _extractable=5, so allow normal extraction
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
        _restored: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // 5 minutes ago
      };

      // With keep_after_restore_seconds=600 (10 min), 5 min ago is still protected
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
        _restored: new Date(Date.now() - 15 * 60 * 1000).toISOString(), // 15 minutes ago
      };

      // With keep_after_restore_seconds=600 (10 min), 15 min ago is past protection
      const result = detectTrigger(entry, baseConfig, 5);

      expect(result.shouldExtract).toBe(true);
    });

    it('protection uses keep_after_restore_seconds from config', () => {
      const entry: SessionEntry = {
        __id: 'ent_032',
        customType: 'thinking',
        thinking: 'a'.repeat(600),
        _restored: new Date(Date.now() - 20 * 1000).toISOString(), // 20 seconds ago
      };

      // With keep_after_restore_seconds=30 (30 sec), 20 sec ago is still protected
      const configShort: TriggerConfig = { ...baseConfig, keep_after_restore_seconds: 30 };
      const result1 = detectTrigger(entry, configShort, 5);
      expect(result1.shouldExtract).toBe(false);

      // With keep_after_restore_seconds=10 (10 sec), 20 sec ago is past protection
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
        _restored: new Date(Date.now() - 5 * 1000).toISOString(), // 5 seconds ago
      };

      // _extractable: true should force extraction even if recently restored
      const result = detectTrigger(entry, baseConfig, 5);

      expect(result.shouldExtract).toBe(true);
    });

    it('_extractable: false overrides restoration protection (still prevents)', () => {
      const entry: SessionEntry = {
        __id: 'ent_034',
        customType: 'thinking',
        thinking: 'a'.repeat(600),
        _extractable: false,
        _restored: new Date(Date.now() - 15 * 60 * 1000).toISOString(), // 15 min ago (past protection)
      };

      // Both _extractable: false AND past protection time → _extractable wins
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

      const result = detectTrigger(entry, { ...baseConfig, trigger_types: ['assistant'] }, 5);

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
});
