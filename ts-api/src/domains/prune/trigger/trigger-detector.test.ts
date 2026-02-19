import { describe, it, expect } from 'vitest';
import { detectTrigger, type SessionEntry, type TriggerConfig } from './trigger-detector.js';

describe('detectTrigger', () => {
  const now = Date.now();
  const oneHourAgo = now - (60 * 60 * 1000);
  const twoDaysAgo = now - (48 * 60 * 60 * 1000);

  const baseConfig: TriggerConfig = {
    enabled: true,
    trigger_types: ['thinking', 'tool_result'],
    age_threshold_hours: 24,
  };

  it('returns no match when disabled', () => {
    const entry: SessionEntry = {
      __id: 'ent_001',
      customType: 'thinking',
      thinking: 'some reasoning',
    };
    
    const result = detectTrigger(entry, { ...baseConfig, enabled: false }, 0, now);
    
    expect(result.matched).toBe(false);
    expect(result.shouldExtract).toBe(false);
  });

  it('matches thinking entries', () => {
    const entry: SessionEntry = {
      __id: 'ent_001',
      customType: 'thinking',
      thinking: 'some reasoning',
      timestamp: twoDaysAgo,
    };
    
    const result = detectTrigger(entry, baseConfig, 0, now);
    
    expect(result.matched).toBe(true);
    expect(result.triggerType).toBe('thinking');
    expect(result.hasId).toBe(true);
    expect(result.ageMeetsThreshold).toBe(true);
    expect(result.shouldExtract).toBe(true);
  });

  it('matches tool_result entries', () => {
    const entry: SessionEntry = {
      __id: 'ent_002',
      type: 'tool_result',
      output: 'command output',
      timestamp: twoDaysAgo,
    };
    
    const result = detectTrigger(entry, baseConfig, 0, now);
    
    expect(result.matched).toBe(true);
    expect(result.triggerType).toBe('tool_result');
    expect(result.shouldExtract).toBe(true);
  });

  it('requires __id field', () => {
    const entry: SessionEntry = {
      customType: 'thinking',
      thinking: 'some reasoning',
      timestamp: twoDaysAgo,
    };
    
    const result = detectTrigger(entry, baseConfig, 0, now);
    
    expect(result.matched).toBe(true);
    expect(result.hasId).toBe(false);
    expect(result.shouldExtract).toBe(false);
  });

  it('rejects entries with [[extracted]] placeholders', () => {
    const entry: SessionEntry = {
      __id: 'ent_003',
      customType: 'thinking',
      thinking: '[[extracted]]',
      timestamp: twoDaysAgo,
    };
    
    const result = detectTrigger(entry, baseConfig, 0, now);
    
    expect(result.matched).toBe(true);
    expect(result.shouldExtract).toBe(false);
  });

  it('respects age threshold', () => {
    const youngEntry: SessionEntry = {
      __id: 'ent_004',
      customType: 'thinking',
      thinking: 'recent thinking',
      timestamp: oneHourAgo,
    };
    
    const result = detectTrigger(youngEntry, baseConfig, 0, now);
    
    expect(result.matched).toBe(true);
    expect(result.ageMeetsThreshold).toBe(false);
    expect(result.shouldExtract).toBe(false);
  });

  it('extracts all ages when threshold is 0', () => {
    const youngEntry: SessionEntry = {
      __id: 'ent_005',
      customType: 'thinking',
      thinking: 'recent thinking',
      timestamp: oneHourAgo,
    };
    
    const result = detectTrigger(youngEntry, { ...baseConfig, age_threshold_hours: 0 }, 0, now);
    
    expect(result.matched).toBe(true);
    expect(result.ageMeetsThreshold).toBe(true);
    expect(result.shouldExtract).toBe(true);
  });

  it('detects type from message.role', () => {
    const entry: SessionEntry = {
      __id: 'ent_006',
      type: 'message',
      message: { role: 'assistant', created_at: new Date(twoDaysAgo).toISOString() },
    };
    
    const config: TriggerConfig = {
      ...baseConfig,
      trigger_types: ['assistant'],
    };
    
    const result = detectTrigger(entry, config, 0, now);
    
    expect(result.matched).toBe(true);
    expect(result.triggerType).toBe('assistant');
  });

  it('detects type from entry.role', () => {
    const entry: SessionEntry = {
      __id: 'ent_007',
      role: 'system',
      content: 'system message',
      timestamp: twoDaysAgo,
    };
    
    const config: TriggerConfig = {
      ...baseConfig,
      trigger_types: ['system'],
    };
    
    const result = detectTrigger(entry, config, 0, now);
    
    expect(result.matched).toBe(true);
    expect(result.triggerType).toBe('system');
  });

  it('uses __ts for age calculation', () => {
    const entry: SessionEntry = {
      __id: 'ent_008',
      customType: 'thinking',
      thinking: 'some reasoning',
      __ts: twoDaysAgo,
    };
    
    const result = detectTrigger(entry, baseConfig, 0, now);
    
    expect(result.ageMs).toBeGreaterThan(48 * 60 * 60 * 1000 - 1000);
    expect(result.ageMeetsThreshold).toBe(true);
  });

  it('uses fallback age estimation when no timestamp', () => {
    const entry: SessionEntry = {
      __id: 'ent_009',
      customType: 'thinking',
      thinking: 'some reasoning',
      // No timestamp fields
    };
    
    // Entry at index 100 (100 * 60s = ~100 min old)
    const result = detectTrigger(entry, { ...baseConfig, age_threshold_hours: 1 }, 100, now);
    
    expect(result.ageMs).toBeGreaterThan(0);
  });

  it('handles ISO string timestamps', () => {
    const entry: SessionEntry = {
      __id: 'ent_010',
      customType: 'thinking',
      thinking: 'some reasoning',
      timestamp: new Date(twoDaysAgo).toISOString(),
    };
    
    const result = detectTrigger(entry, baseConfig, 0, now);
    
    expect(result.ageMs).toBeGreaterThan(48 * 60 * 60 * 1000 - 1000);
  });

  it('infers thinking type from content structure', () => {
    const entry: SessionEntry = {
      __id: 'ent_011',
      data: { thinking: 'nested reasoning' },
      timestamp: twoDaysAgo,
    };
    
    const result = detectTrigger(entry, baseConfig, 0, now);
    
    expect(result.matched).toBe(true);
    expect(result.triggerType).toBe('thinking');
  });

  it('returns non-negative age for future timestamps', () => {
    const futureEntry: SessionEntry = {
      __id: 'ent_012',
      customType: 'thinking',
      thinking: 'some reasoning',
      timestamp: now + 1000000, // Future
    };
    
    const result = detectTrigger(futureEntry, baseConfig, 0, now);
    
    expect(result.ageMs).toBe(0);
  });

  it('only matches configured trigger_types', () => {
    const entry: SessionEntry = {
      __id: 'ent_013',
      type: 'message',
      message: { role: 'user' },
      timestamp: twoDaysAgo,
    };
    
    // user not in trigger_types
    const result = detectTrigger(entry, baseConfig, 0, now);
    
    expect(result.matched).toBe(false);
    expect(result.shouldExtract).toBe(false);
  });
});
