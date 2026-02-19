import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  parseJsonl,
  serializeJsonl,
  streamJsonl,
  countJsonlEntries,
  getLastEntries,
} from '../infrastructure/jsonl/index.js';

const TEMP_DIR = join(tmpdir(), 'brainsurgeon-jsonl-test-' + randomUUID());

describe('JSONL Library', () => {
  beforeAll(async () => {
    await mkdir(TEMP_DIR, { recursive: true });
  });

  afterAll(async () => {
    await rm(TEMP_DIR, { recursive: true, force: true });
  });

  describe('parseJsonl', () => {
    it('parses valid JSONL content', () => {
      const content = '{"id":1,"type":"message"}\n{"id":2,"type":"tool"}\n';
      const entries = parseJsonl(content);

      expect(entries).toHaveLength(2);
      expect(entries[0]).toEqual({ id: 1, type: 'message' });
      expect(entries[1]).toEqual({ id: 2, type: 'tool' });
    });

    it('skips empty lines', () => {
      const content = '{"id":1}\n\n{"id":2}\n\n';
      const entries = parseJsonl(content);

      expect(entries).toHaveLength(2);
    });

    it('respects limit option', () => {
      const content = '{"id":1}\n{"id":2}\n{"id":3}\n';
      const entries = parseJsonl(content, { limit: 2 });

      expect(entries).toHaveLength(2);
      expect(entries[0].id).toBe(1);
      expect(entries[1].id).toBe(2);
    });

    it('skips invalid lines by default', () => {
      const content = '{"id":1}\ninvalid json\n{"id":3}\n';
      const entries = parseJsonl(content);

      expect(entries).toHaveLength(2);
      expect(entries[0].id).toBe(1);
      expect(entries[1].id).toBe(3);
    });

    it('throws on invalid lines when skipInvalid=false', () => {
      const content = '{"id":1}\ninvalid json\n';

      expect(() => parseJsonl(content, { skipInvalid: false })).toThrow('Invalid JSON');
    });
  });

  describe('serializeJsonl', () => {
    it('serializes entries to JSONL format', () => {
      const entries = [{ id: 1 }, { id: 2 }];
      const result = serializeJsonl(entries);

      expect(result).toBe('{"id":1}\n{"id":2}\n');
    });
  });

  describe('streamJsonl', () => {
    it('streams entries from file', async () => {
      const filePath = join(TEMP_DIR, 'test-stream.jsonl');
      const content = '{"id":1}\n{"id":2}\n{"id":3}\n';
      await writeFile(filePath, content);

      const entries: unknown[] = [];
      for await (const entry of streamJsonl(filePath)) {
        entries.push(entry);
      }

      expect(entries).toHaveLength(3);
      expect(entries[0]).toEqual({ id: 1 });
    });

    it('respects limit when streaming', async () => {
      const filePath = join(TEMP_DIR, 'test-stream-limit.jsonl');
      const content = '{"id":1}\n{"id":2}\n{"id":3}\n';
      await writeFile(filePath, content);

      const entries: unknown[] = [];
      for await (const entry of streamJsonl(filePath, { limit: 2 })) {
        entries.push(entry);
      }

      expect(entries).toHaveLength(2);
    });
  });

  describe('countJsonlEntries', () => {
    it('counts entries without loading them', async () => {
      const filePath = join(TEMP_DIR, 'test-count.jsonl');
      const content = '{"id":1}\n{"id":2}\n{"id":3}\n{"id":4}\n';
      await writeFile(filePath, content);

      const count = await countJsonlEntries(filePath);

      expect(count).toBe(4);
    });
  });

  describe('getLastEntries', () => {
    it('returns last N entries', async () => {
      const filePath = join(TEMP_DIR, 'test-last.jsonl');
      const content = '{"id":1}\n{"id":2}\n{"id":3}\n{"id":4}\n';
      await writeFile(filePath, content);

      const entries = await getLastEntries(filePath, 2);

      expect(entries).toHaveLength(2);
      expect(entries[0]).toEqual({ id: 3 });
      expect(entries[1]).toEqual({ id: 4 });
    });
  });
});
