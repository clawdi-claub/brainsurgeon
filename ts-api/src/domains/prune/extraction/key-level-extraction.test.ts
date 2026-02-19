import { describe, it, expect } from 'vitest';
import {
  extractEntryKeys,
  createPlaceholderEntry,
  hasExtractedPlaceholders,
  restoreExtractedContent,
} from './key-level-extraction.js';
import type { SessionEntry } from '../trigger/trigger-detector.js';

describe('extractEntryKeys', () => {
  it('extracts thinking entry keys', () => {
    const entry: SessionEntry = {
      __id: 'ent_001',
      customType: 'thinking',
      thinking: 'step by step reasoning...',
      model: 'gpt-4',
      timestamp: Date.now(),
    };

    const result = extractEntryKeys(entry, 'thinking');

    expect(result.success).toBe(true);
    expect(result.extractedKeys).toContain('thinking');
    expect(result.extractedData.thinking).toBe('step by step reasoning...');
    expect(result.modifiedEntry.thinking).toBe('[[extracted]]');
    expect(result.modifiedEntry.__id).toBe('ent_001');
    expect(result.extractedData.__meta).toBeDefined();
  });

  it('extracts tool result keys', () => {
    const entry: SessionEntry = {
      __id: 'ent_002',
      type: 'tool_result',
      output: 'command output data',
      exitCode: 0,
      timestamp: Date.now(),
    };

    const result = extractEntryKeys(entry, 'tool_result');

    expect(result.success).toBe(true);
    expect(result.extractedKeys).toContain('output');
    expect(result.extractedData.output).toBe('command output data');
    expect(result.modifiedEntry.output).toBe('[[extracted]]');
  });

  it('preserves __id in modified entry', () => {
    const entry: SessionEntry = {
      __id: 'ent_003',
      customType: 'thinking',
      thinking: 'reasoning',
    };

    const result = extractEntryKeys(entry, 'thinking');

    expect(result.modifiedEntry.__id).toBe('ent_003');
    expect(result.extractedKeys).not.toContain('__id');
  });

  it('skips metadata keys (__)', () => {
    const entry: SessionEntry = {
      __id: 'ent_004',
      __ts: 1234567890,
      __hash: 'abc123',
      customType: 'thinking',
      thinking: 'reasoning',
    };

    const result = extractEntryKeys(entry, 'thinking');

    expect(result.extractedKeys).not.toContain('__ts');
    expect(result.extractedKeys).not.toContain('__hash');
    expect(result.modifiedEntry.__ts).toBe(1234567890);
  });

  it('handles nested data objects', () => {
    const entry: SessionEntry = {
      __id: 'ent_005',
      customType: 'thinking',
      type: 'custom',
      data: {
        thinking: 'nested reasoning',
        extra: 'other data',
      },
    };

    const result = extractEntryKeys(entry, 'thinking');

    expect(result.success).toBe(true);
    expect(result.extractedData.data).toBeDefined();
    expect(result.extractedData.data.thinking).toBe('nested reasoning');
    expect(result.modifiedEntry.data.thinking).toBe('[[extracted]]');
  });

  it('calculates extracted size', () => {
    const entry: SessionEntry = {
      __id: 'ent_006',
      customType: 'thinking',
      thinking: 'reasoning content',
    };

    const result = extractEntryKeys(entry, 'thinking');

    expect(result.extractedSize).toBeGreaterThan(0);
    expect(result.extractedSize).toBe(JSON.stringify(result.extractedData).length);
  });

  it('handles error gracefully', () => {
    // Create entry with circular reference (will cause JSON error)
    const entry: any = {
      __id: 'ent_007',
      customType: 'thinking',
    };
    entry.circular = entry;

    const result = extractEntryKeys(entry, 'thinking');

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe('createPlaceholderEntry', () => {
  it('creates minimal placeholder with __id', () => {
    const entry: SessionEntry = {
      __id: 'ent_008',
      type: 'message',
      content: 'long content',
      data: { extra: 'info' },
    };

    const placeholder = createPlaceholderEntry(entry);

    expect(placeholder.__id).toBe('ent_008');
    expect(placeholder.type).toBe('message');
    expect(placeholder.content).toBeUndefined();
    expect(placeholder.data).toBeUndefined();
  });

  it('preserves __metadata fields', () => {
    const entry: SessionEntry = {
      __id: 'ent_009',
      __ts: 1234567890,
      __hash: 'abc123',
      type: 'thinking',
      thinking: 'content',
    };

    const placeholder = createPlaceholderEntry(entry);

    expect(placeholder.__ts).toBe(1234567890);
    expect(placeholder.__hash).toBe('abc123');
    expect(placeholder.thinking).toBeUndefined();
  });
});

describe('hasExtractedPlaceholders', () => {
  it('detects [[extracted]] placeholder', () => {
    const entry: SessionEntry = {
      __id: 'ent_010',
      content: '[[extracted]]',
    };

    expect(hasExtractedPlaceholders(entry)).toBe(true);
  });

  it('detects nested placeholder', () => {
    const entry: SessionEntry = {
      __id: 'ent_011',
      data: {
        output: '[[extracted]]',
      },
    };

    expect(hasExtractedPlaceholders(entry)).toBe(true);
  });

  it('returns false when no placeholders', () => {
    const entry: SessionEntry = {
      __id: 'ent_012',
      content: 'actual content',
    };

    expect(hasExtractedPlaceholders(entry)).toBe(false);
  });
});

describe('restoreExtractedContent', () => {
  it('restores extracted values', () => {
    const placeholder: SessionEntry = {
      __id: 'ent_013',
      type: 'thinking',
      thinking: '[[extracted]]',
      model: '[[extracted]]',
    };

    const extractedData = {
      thinking: 'original reasoning',
      model: 'gpt-4',
      __meta: { extracted_at: '2024-01-01' },
    };

    const restored = restoreExtractedContent(placeholder, extractedData);

    expect(restored.thinking).toBe('original reasoning');
    expect(restored.model).toBe('gpt-4');
    expect(restored.__id).toBe('ent_013');
  });

  it('preserves original values for non-extracted keys', () => {
    const placeholder: SessionEntry = {
      __id: 'ent_014',
      type: 'thinking',
      thinking: '[[extracted]]',
      timestamp: 1234567890,
    };

    const extractedData = {
      thinking: 'reasoning',
      __meta: {},
    };

    const restored = restoreExtractedContent(placeholder, extractedData);

    expect(restored.thinking).toBe('reasoning');
    expect(restored.timestamp).toBe(1234567890);
  });

  it('handles missing extracted values gracefully', () => {
    const placeholder: SessionEntry = {
      __id: 'ent_015',
      thinking: '[[extracted]]',
      missing: '[[extracted]]',
    };

    const extractedData = {
      thinking: 'reasoning',
      __meta: {},
    };

    const restored = restoreExtractedContent(placeholder, extractedData);

    expect(restored.thinking).toBe('reasoning');
    // Missing key stays as placeholder (acceptable degradation)
    expect(restored.missing).toBe('[[extracted]]');
  });

  it('restores nested data content', () => {
    const placeholder: SessionEntry = {
      __id: 'ent_016',
      data: {
        thinking: '[[extracted]]',
        extra: 'preserved',
      },
    };

    const extractedData = {
      data: {
        thinking: 'nested reasoning',
      },
      __meta: {},
    };

    const restored = restoreExtractedContent(placeholder, extractedData);

    expect(restored.data.thinking).toBe('nested reasoning');
    expect(restored.data.extra).toBe('preserved');
  });
});
