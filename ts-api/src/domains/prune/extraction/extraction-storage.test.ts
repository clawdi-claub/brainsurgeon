import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ExtractionStorage } from './extraction-storage.js';

let tmpDir: string;
let storage: ExtractionStorage;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'extraction-test-'));
  storage = new ExtractionStorage({ agentsDir: tmpDir });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('ExtractionStorage', () => {
  const agent = 'test-agent';
  const session = 'sess-001';
  const entryId = 'ent-abc123';

  describe('store', () => {
    it('creates directory and writes file atomically', async () => {
      const data = { thinking: 'step by step...', __meta: { extracted_at: '2026-01-01' } };
      const result = await storage.store(agent, session, entryId, data);

      expect(result.sizeBytes).toBeGreaterThan(0);
      expect(result.filePath).toContain(`${entryId}.json`);

      // Verify file exists and is valid JSON
      const content = await readFile(result.filePath, 'utf8');
      const parsed = JSON.parse(content);
      expect(parsed.thinking).toBe('step by step...');
    });

    it('creates directory with mode 0o700', async () => {
      await storage.store(agent, session, entryId, { foo: 'bar' });
      const dir = storage.extractedDir(agent, session);
      const s = await stat(dir);
      // Check owner has rwx (0o700 on Linux)
      expect(s.mode & 0o700).toBe(0o700);
    });

    it('overwrites existing file', async () => {
      await storage.store(agent, session, entryId, { v: 1 });
      await storage.store(agent, session, entryId, { v: 2 });

      const data = await storage.read(agent, session, entryId);
      expect(data).toEqual({ v: 2 });
    });
  });

  describe('read', () => {
    it('returns stored data', async () => {
      const original = { key: 'value', nested: { a: 1 } };
      await storage.store(agent, session, entryId, original);

      const result = await storage.read(agent, session, entryId);
      expect(result).toEqual(original);
    });

    it('returns null for missing file', async () => {
      const result = await storage.read(agent, session, 'nonexistent');
      expect(result).toBeNull();
    });

    it('returns null for missing session dir', async () => {
      const result = await storage.read('no-agent', 'no-session', 'no-entry');
      expect(result).toBeNull();
    });
  });

  describe('list', () => {
    it('lists entry IDs for a session', async () => {
      await storage.store(agent, session, 'ent-1', { a: 1 });
      await storage.store(agent, session, 'ent-2', { b: 2 });
      await storage.store(agent, session, 'ent-3', { c: 3 });

      const ids = await storage.list(agent, session);
      expect(ids.sort()).toEqual(['ent-1', 'ent-2', 'ent-3']);
    });

    it('returns empty array for missing session', async () => {
      const ids = await storage.list(agent, 'no-session');
      expect(ids).toEqual([]);
    });

    it('ignores dot-prefixed files', async () => {
      await storage.store(agent, session, 'ent-1', { a: 1 });
      // Create a dot-prefixed file (leftover tmp)
      const dir = storage.extractedDir(agent, session);
      await writeFile(join(dir, '.tmp-leftover.json'), '{}');

      const ids = await storage.list(agent, session);
      expect(ids).toEqual(['ent-1']);
    });
  });

  describe('delete', () => {
    it('deletes a single entry', async () => {
      await storage.store(agent, session, entryId, { data: 'test' });
      const deleted = await storage.delete(agent, session, entryId);
      expect(deleted).toBe(true);

      const result = await storage.read(agent, session, entryId);
      expect(result).toBeNull();
    });

    it('returns false for missing entry', async () => {
      const deleted = await storage.delete(agent, session, 'nonexistent');
      expect(deleted).toBe(false);
    });
  });

  describe('deleteAll', () => {
    it('deletes entire session directory', async () => {
      await storage.store(agent, session, 'ent-1', { a: 1 });
      await storage.store(agent, session, 'ent-2', { b: 2 });

      const count = await storage.deleteAll(agent, session);
      expect(count).toBe(2);

      const ids = await storage.list(agent, session);
      expect(ids).toEqual([]);
    });

    it('returns 0 for missing session', async () => {
      const count = await storage.deleteAll(agent, 'no-session');
      expect(count).toBe(0);
    });
  });

  describe('sessionSize', () => {
    it('returns file count and total bytes', async () => {
      await storage.store(agent, session, 'ent-1', { data: 'x'.repeat(100) });
      await storage.store(agent, session, 'ent-2', { data: 'y'.repeat(200) });

      const size = await storage.sessionSize(agent, session);
      expect(size.files).toBe(2);
      expect(size.bytes).toBeGreaterThan(300);
    });

    it('returns zeros for missing session', async () => {
      const size = await storage.sessionSize(agent, 'no-session');
      expect(size).toEqual({ files: 0, bytes: 0 });
    });
  });

  describe('findExpired', () => {
    it('finds files older than maxAgeMs', async () => {
      await storage.store(agent, session, 'ent-old', { old: true });

      // findExpired with maxAgeMs=0 means everything is expired
      const expired = await storage.findExpired(0);
      expect(expired.length).toBe(1);
      expect(expired[0].entryId).toBe('ent-old');
      expect(expired[0].agentId).toBe(agent);
      expect(expired[0].sessionId).toBe(session);
    });

    it('excludes recently written files', async () => {
      await storage.store(agent, session, 'ent-new', { fresh: true });

      // maxAge of 1 hour — file just written should not be expired
      const expired = await storage.findExpired(3_600_000);
      expect(expired.length).toBe(0);
    });

    it('returns empty for no agents dir', async () => {
      const emptyStorage = new ExtractionStorage({ agentsDir: '/tmp/nonexistent-dir-xyz' });
      const expired = await emptyStorage.findExpired(0);
      expect(expired).toEqual([]);
    });
  });
});
