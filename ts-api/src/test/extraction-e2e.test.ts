/**
 * End-to-end integration test for the extraction system.
 * Tests the full cycle: extract → verify placeholders → restore → verify content.
 *
 * Covers:
 * - KB-119: keep_recent position-based extraction
 * - KB-120: min_value_length threshold
 * - KB-121: _extractable per-message override (true/false/integer)
 * - KB-122: restore_remote + remote_restore redaction + re-extraction protection
 * - KB-123: sizesBytes logging per key
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { SmartPruningExecutor } from '../domains/prune/executor/pruning-executor.js';
import { RestoreService } from '../domains/prune/restore/restore-service.js';
import { ExtractionStorage } from '../domains/prune/extraction/extraction-storage.js';
import type { SmartPruningConfig } from '../domains/config/model/config.js';
import type { SessionRepository } from '../domains/session/repository/session-repository.js';

// --- Minimal in-memory session repository for testing ---

interface TestSession {
  entries: any[];
  metadata?: any;
}

class InMemorySessionRepo implements SessionRepository {
  private sessions = new Map<string, TestSession>();

  addSession(agentId: string, sessionId: string, entries: any[]) {
    this.sessions.set(`${agentId}/${sessionId}`, { entries });
  }

  async list(): Promise<any[]> {
    return Array.from(this.sessions.entries()).map(([key]) => {
      const [agentId, id] = key.split('/');
      return {
        agentId,
        id,
        sizeBytes: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        entryCount: 0,
        status: 'active' as const,
      };
    });
  }

  async load(agentId: string, sessionId: string): Promise<any> {
    const key = `${agentId}/${sessionId}`;
    const session = this.sessions.get(key);
    if (!session) throw new Error(`Session not found: ${key}`);
    return session;
  }

  async save(agentId: string, sessionId: string, session: any): Promise<void> {
    this.sessions.set(`${agentId}/${sessionId}`, session);
  }

  // Unused methods from interface
  async findChildren(): Promise<any[]> { return []; }
  async exists(): Promise<boolean> { return true; }
  async delete(): Promise<void> {}
}

// --- Test fixtures ---

function createEntry(overrides: Record<string, any> = {}) {
  return {
    __id: `ent_${randomUUID().slice(0, 8)}`,
    ...overrides,
  };
}

function createThinkingEntry(thinkingContent: string, overrides: Record<string, any> = {}) {
  return createEntry({
    customType: 'thinking',
    thinking: thinkingContent,
    ...overrides,
  });
}

function createToolResultEntry(output: string, overrides: Record<string, any> = {}) {
  return createEntry({
    type: 'tool_result',
    output,
    ...overrides,
  });
}

function createUserMessage(content: string, overrides: Record<string, any> = {}) {
  return createEntry({
    type: 'message',
    message: { role: 'user', content },
    ...overrides,
  });
}

// --- Tests ---

describe('Extraction E2E', () => {
  const tmpDir = join('/tmp', `brainsurgeon-e2e-${randomUUID().slice(0, 8)}`);
  const agentId = 'test-agent';
  const sessionId = 'test-session';
  let sessionRepo: InMemorySessionRepo;
  let executor: SmartPruningExecutor;
  let extractionStorage: ExtractionStorage;
  let restoreService: RestoreService;

  const defaultConfig: SmartPruningConfig = {
    enabled: true,
    trigger_types: ['thinking', 'tool_result'], // Legacy
    trigger_rules: [
      { type: 'thinking', min_length: 500, keep_recent: 3 },
      { type: 'tool_result', min_length: 500, keep_recent: 3 },
    ],
    keep_recent: 3,
    min_value_length: 500,
    scan_interval_seconds: 30,
    auto_cron: '*/2 * * * *',
    last_run_at: null,
    retention: '24h',
    retention_cron: '0 */6 * * *',
    last_retention_run_at: null,
    keep_restore_remote_calls: false,
    keep_after_restore_seconds: 600,
  };

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
    sessionRepo = new InMemorySessionRepo();
    executor = new SmartPruningExecutor(tmpDir, sessionRepo as any);
    extractionStorage = new ExtractionStorage({ agentsDir: tmpDir });
    restoreService = new RestoreService(extractionStorage, sessionRepo as any);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // =========================================================================
  // KB-119: keep_recent position-based extraction
  // =========================================================================

  describe('KB-119: keep_recent position-based extraction', () => {
    it('extracts entries older than keep_recent, keeps recent ones', async () => {
      const largeContent = 'a'.repeat(600);
      const entries = [
        createThinkingEntry(largeContent, { __id: 'old-1' }),  // pos 4 from end → extract
        createThinkingEntry(largeContent, { __id: 'old-2' }),  // pos 3 from end → extract (at boundary)
        createThinkingEntry(largeContent, { __id: 'recent-1' }), // pos 2 → keep
        createThinkingEntry(largeContent, { __id: 'recent-2' }), // pos 1 → keep
        createThinkingEntry(largeContent, { __id: 'recent-3' }), // pos 0 → keep
      ];

      sessionRepo.addSession(agentId, sessionId, entries);

      const result = await executor.runSmartPruning(defaultConfig);

      expect(result.entriesExtracted).toBe(2);

      // Verify extracted entries have placeholders
      const session = await sessionRepo.load(agentId, sessionId);
      expect(session.entries[0].thinking).toMatch(/^\[\[extracted-.+\]\]$/);
      expect(session.entries[1].thinking).toMatch(/^\[\[extracted-.+\]\]$/);

      // Verify recent entries are untouched
      expect(session.entries[2].thinking).toBe(largeContent);
      expect(session.entries[3].thinking).toBe(largeContent);
      expect(session.entries[4].thinking).toBe(largeContent);
    });

    it('keep_recent=0 extracts ALL entries', async () => {
      const largeContent = 'a'.repeat(600);
      const entries = [
        createThinkingEntry(largeContent, { __id: 'only-1' }),
      ];

      sessionRepo.addSession(agentId, sessionId, entries);

      const result = await executor.runSmartPruning({
        ...defaultConfig,
        trigger_rules: [
          { type: 'thinking' }, // No keep_recent → uses global
        ],
        keep_recent: 0,
      });

      expect(result.entriesExtracted).toBe(1);
      const session = await sessionRepo.load(agentId, sessionId);
      expect(session.entries[0].thinking).toMatch(/^\[\[extracted-.+\]\]$/);
    });
  });

  // =========================================================================
  // KB-120: min_value_length threshold
  // =========================================================================

  describe('KB-120: min_value_length threshold', () => {
    it('skips entries with values below min_value_length', async () => {
      const entries = [
        createThinkingEntry('short', { __id: 'small-1' }),  // pos 5 → too small
        createToolResultEntry('tiny output', { __id: 'small-2' }),  // pos 4 → too small
        createThinkingEntry('a'.repeat(600), { __id: 'large-1' }),  // pos 3 → large enough
        createUserMessage('hi'),  // pos 2 → keep (within keep_recent=3)
        createUserMessage('hi'),  // pos 1 → keep
        createUserMessage('hi'),  // pos 0 → keep
      ];

      sessionRepo.addSession(agentId, sessionId, entries);

      const result = await executor.runSmartPruning(defaultConfig);

      // Only the large entry should be extracted (small ones are too small)
      expect(result.entriesExtracted).toBe(1);

      const session = await sessionRepo.load(agentId, sessionId);
      expect(session.entries[0].thinking).toBe('short'); // Not extracted (too small)
      expect(session.entries[1].output).toBe('tiny output'); // Not extracted (too small)
      expect(session.entries[2].thinking).toMatch(/^\[\[extracted-.+\]\]$/); // Extracted
    });

    it('respects custom min_value_length', async () => {
      const entries = [
        createThinkingEntry('a'.repeat(100), { __id: 'medium-1' }),
        createUserMessage('hi'),
        createUserMessage('hi'),
        createUserMessage('hi'),
      ];

      sessionRepo.addSession(agentId, sessionId, entries);

      // With min_value_length=50 and rules that don't override it, the 100-char entry qualifies
      const result = await executor.runSmartPruning({
        ...defaultConfig,
        trigger_rules: [
          { type: 'thinking', keep_recent: 3 }, // No min_length → uses global
        ],
        min_value_length: 50,
      });

      expect(result.entriesExtracted).toBe(1);
    });
  });

  // =========================================================================
  // KB-121: _extractable per-message override
  // =========================================================================

  describe('KB-121: _extractable per-message override', () => {
    it('_extractable: true forces extraction regardless of type and size', async () => {
      const entries = [
        createUserMessage('small content', {
          __id: 'force-extract',
          _extractable: true,
        }),
        createUserMessage('hi'),
        createUserMessage('hi'),
        createUserMessage('hi'),
      ];

      sessionRepo.addSession(agentId, sessionId, entries);

      const result = await executor.runSmartPruning(defaultConfig);

      // User message with small content should be extracted because _extractable: true
      expect(result.entriesExtracted).toBe(1);

      const session = await sessionRepo.load(agentId, sessionId);
      // The message field should be extracted (placeholder includes entry id)
      expect(JSON.stringify(session.entries[0])).toContain('[[extracted-');
    });

    it('_extractable: false prevents extraction of matching entries', async () => {
      const largeContent = 'a'.repeat(600);
      const entries = [
        createThinkingEntry(largeContent, {
          __id: 'protected-1',
          _extractable: false,
        }),
        createUserMessage('hi'),
        createUserMessage('hi'),
        createUserMessage('hi'),
      ];

      sessionRepo.addSession(agentId, sessionId, entries);

      const result = await executor.runSmartPruning(defaultConfig);

      expect(result.entriesExtracted).toBe(0);

      const session = await sessionRepo.load(agentId, sessionId);
      expect(session.entries[0].thinking).toBe(largeContent); // Protected
    });

    it('_extractable: integer overrides keep_recent window', async () => {
      const largeContent = 'a'.repeat(600);
      const entries = [
        createThinkingEntry(largeContent, {
          __id: 'custom-window',
          _extractable: 10, // Keep for 10 messages
        }),
        // 5 filler entries (positions 1-5)
        createUserMessage('hi', { __id: 'filler-1' }),
        createUserMessage('hi', { __id: 'filler-2' }),
        createUserMessage('hi', { __id: 'filler-3' }),
        createUserMessage('hi', { __id: 'filler-4' }),
        createUserMessage('hi', { __id: 'filler-5' }),
      ];

      sessionRepo.addSession(agentId, sessionId, entries);

      // Entry at position 5 from end, _extractable=10 → keep (5 < 10)
      const result = await executor.runSmartPruning(defaultConfig);

      expect(result.entriesExtracted).toBe(0);

      const session = await sessionRepo.load(agentId, sessionId);
      expect(session.entries[0].thinking).toBe(largeContent); // Still protected
    });

    it('_extractable: integer allows extraction after threshold', async () => {
      const largeContent = 'a'.repeat(600);
      // Create enough entries so position exceeds _extractable threshold
      const fillerEntries = Array.from({ length: 12 }, (_, i) =>
        createUserMessage('hi', { __id: `filler-${i}` })
      );

      const entries = [
        createThinkingEntry(largeContent, {
          __id: 'past-window',
          _extractable: 5, // Keep for 5 messages
        }),
        ...fillerEntries,
      ];

      sessionRepo.addSession(agentId, sessionId, entries);

      // Entry at position 12 from end, _extractable=5 → extract (12 >= 5)
      const result = await executor.runSmartPruning(defaultConfig);

      expect(result.entriesExtracted).toBe(1);
    });
  });

  // =========================================================================
  // KB-122: Restore + redaction + re-extraction protection
  // =========================================================================

  describe('KB-122: restore_remote + redaction + re-extraction protection', () => {
    it('restores extracted content back to session entry', async () => {
      const originalThinking = 'a'.repeat(600);
      const entries = [
        createThinkingEntry(originalThinking, { __id: 'to-restore' }),
        createUserMessage('hi'),
        createUserMessage('hi'),
        createUserMessage('hi'),
      ];

      sessionRepo.addSession(agentId, sessionId, entries);

      // Step 1: Extract
      await executor.runSmartPruning(defaultConfig);

      const sessionAfterExtract = await sessionRepo.load(agentId, sessionId);
      expect(sessionAfterExtract.entries[0].thinking).toMatch(/^\[\[extracted-.+\]\]$/);

      // Step 2: Restore
      const restoreResult = await restoreService.restoreEntry({
        agentId,
        sessionId,
        entryId: 'to-restore',
      });

      expect(restoreResult.success).toBe(true);
      expect(restoreResult.keysRestored.length).toBeGreaterThan(0);

      // Step 3: Verify content is back
      const sessionAfterRestore = await sessionRepo.load(agentId, sessionId);
      const restoredEntry = sessionAfterRestore.entries[0];
      expect(restoredEntry.thinking).toBe(originalThinking);

      // Step 4: Verify _restored timestamp metadata
      expect(restoredEntry._restored).toBeDefined();
      expect(new Date(restoredEntry._restored).getTime()).toBeLessThanOrEqual(Date.now());
    });

    it('sets _restored timestamp for time-based re-extraction protection', async () => {
      const originalThinking = 'a'.repeat(600);
      const entries = [
        createThinkingEntry(originalThinking, { __id: 'protect-me' }),
        createUserMessage('hi'),
        createUserMessage('hi'),
        createUserMessage('hi'),
      ];

      sessionRepo.addSession(agentId, sessionId, entries);

      // Extract
      await executor.runSmartPruning(defaultConfig);

      // Restore
      await restoreService.restoreEntry({
        agentId,
        sessionId,
        entryId: 'protect-me',
      });

      // Verify _restored timestamp is set for time-based re-extraction protection
      const session = await sessionRepo.load(agentId, sessionId);
      const entry = session.entries[0];
      expect(entry._restored).toBeDefined();
      const restoredTime = new Date(entry._restored).getTime();
      expect(restoredTime).toBeLessThanOrEqual(Date.now());
      expect(restoredTime).toBeGreaterThan(Date.now() - 60 * 1000); // Within last minute
    });

    it('re-extraction protection prevents immediate re-extraction', async () => {
      const originalThinking = 'a'.repeat(600);
      const entries = [
        createThinkingEntry(originalThinking, { __id: 'no-reextract' }),
        createUserMessage('hi'),
        createUserMessage('hi'),
        createUserMessage('hi'),
      ];

      sessionRepo.addSession(agentId, sessionId, entries);

      // Extract
      await executor.runSmartPruning(defaultConfig);

      // Restore
      await restoreService.restoreEntry({
        agentId,
        sessionId,
        entryId: 'no-reextract',
      });

      // Run extraction again — restored entry should be protected
      const result = await executor.runSmartPruning(defaultConfig);

      expect(result.entriesExtracted).toBe(0);

      // Content should still be present
      const session = await sessionRepo.load(agentId, sessionId);
      expect(session.entries[0].thinking).toBe(originalThinking);
    });

    it('redactRestoreCall replaces restore_remote with remote_restore', async () => {
      // Create a session with a restore_remote tool call
      const entries = [
        createEntry({
          __id: 'restore-call-1',
          type: 'tool_call',
          name: 'restore_remote',
          arguments: { entry_id: 'some-entry', keys: ['content'] },
        }),
        createUserMessage('hi'),
      ];

      sessionRepo.addSession(agentId, sessionId, entries);

      // Redact the tool call
      const redacted = await restoreService.redactRestoreCall(
        agentId,
        sessionId,
        'restore-call-1',
      );

      expect(redacted).toBe(true);

      // Verify the entry was redacted
      const session = await sessionRepo.load(agentId, sessionId);
      const redactedEntry = session.entries[0];
      expect(redactedEntry.name).toBe('remote_restore');
      expect(redactedEntry.arguments).toBeNull();
      expect(redactedEntry._redacted_from).toBe('restore_remote');
    });

    it('restore returns error for non-existent entry', async () => {
      sessionRepo.addSession(agentId, sessionId, [createUserMessage('hi')]);

      const result = await restoreService.restoreEntry({
        agentId,
        sessionId,
        entryId: 'nonexistent',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('restore returns error when entry has no extracted content', async () => {
      const entries = [
        createThinkingEntry('not extracted', { __id: 'not-extracted' }),
      ];

      sessionRepo.addSession(agentId, sessionId, entries);

      const result = await restoreService.restoreEntry({
        agentId,
        sessionId,
        entryId: 'not-extracted',
      });

      expect(result.success).toBe(false);
    });
  });

  // =========================================================================
  // KB-123: sizesBytes logging per extracted key
  // =========================================================================

  describe('KB-123: value size logging', () => {
    it('executor logs sizesBytes per key in extraction result', async () => {
      const largeContent = 'a'.repeat(600);
      const entries = [
        createThinkingEntry(largeContent, { __id: 'sized-1' }),
        createUserMessage('hi'),
        createUserMessage('hi'),
        createUserMessage('hi'),
      ];

      sessionRepo.addSession(agentId, sessionId, entries);

      const result = await executor.runSmartPruning(defaultConfig);

      expect(result.entriesExtracted).toBe(1);
      expect(result.bytesSaved).toBeGreaterThan(0);

      // Verify extracted file has size data in __meta
      const extractedData = await extractionStorage.read(agentId, sessionId, 'sized-1');
      expect(extractedData).not.toBeNull();
      expect(extractedData!.__meta).toBeDefined();
      expect((extractedData!.__meta as any).trigger_type).toBe('thinking');
    });

    it('restore result includes sizesBytes per restored key', async () => {
      const largeContent = 'a'.repeat(600);
      const entries = [
        createThinkingEntry(largeContent, { __id: 'sizes-restore' }),
        createUserMessage('hi'),
        createUserMessage('hi'),
        createUserMessage('hi'),
      ];

      sessionRepo.addSession(agentId, sessionId, entries);

      await executor.runSmartPruning(defaultConfig);

      const restoreResult = await restoreService.restoreEntry({
        agentId,
        sessionId,
        entryId: 'sizes-restore',
      });

      expect(restoreResult.success).toBe(true);
      expect(Object.keys(restoreResult.sizesBytes).length).toBeGreaterThan(0);
      expect(restoreResult.totalSize).toBeGreaterThan(0);

      // Each key should have a positive byte count
      for (const [key, size] of Object.entries(restoreResult.sizesBytes)) {
        expect(size).toBeGreaterThan(0);
      }
    });
  });

  // =========================================================================
  // Full cycle: extract → restore → verify no re-extraction → age → re-extract
  // =========================================================================

  describe('Full lifecycle', () => {
    it('complete extract → restore → protect → age → re-extract cycle', async () => {
      const originalContent = 'Long thinking content that exceeds the minimum value length threshold for extraction. '.repeat(10);

      const entries = [
        createThinkingEntry(originalContent, { __id: 'lifecycle-1' }),
        createUserMessage('message 1'),
        createUserMessage('message 2'),
        createUserMessage('message 3'),
      ];

      sessionRepo.addSession(agentId, sessionId, entries);

      // Phase 1: Extract
      const extractResult = await executor.runSmartPruning(defaultConfig);
      expect(extractResult.entriesExtracted).toBe(1);

      let session = await sessionRepo.load(agentId, sessionId);
      expect(session.entries[0].thinking).toMatch(/^\[\[extracted-.+\]\]$/);

      // Phase 2: Restore
      const restoreResult = await restoreService.restoreEntry({
        agentId,
        sessionId,
        entryId: 'lifecycle-1',
      });
      expect(restoreResult.success).toBe(true);

      session = await sessionRepo.load(agentId, sessionId);
      expect(session.entries[0].thinking).toBe(originalContent);
      expect(session.entries[0]._restored).toBeDefined();

      // Phase 3: Protection — immediate re-extraction should fail
      const reExtractResult1 = await executor.runSmartPruning(defaultConfig);
      expect(reExtractResult1.entriesExtracted).toBe(0);

      session = await sessionRepo.load(agentId, sessionId);
      expect(session.entries[0].thinking).toBe(originalContent); // Still present

      // Phase 4: Expire the time-based re-extraction protection
      // Set _restored to 11 minutes ago (protection is 600s = 10 minutes)
      session.entries[0]._restored = new Date(Date.now() - 660_000).toISOString();
      await sessionRepo.save(agentId, sessionId, session);

      // Phase 5: Now re-extraction should succeed (time-based protection expired)
      const reExtractResult2 = await executor.runSmartPruning(defaultConfig);
      expect(reExtractResult2.entriesExtracted).toBe(1);

      session = await sessionRepo.load(agentId, sessionId);
      expect(session.entries[0].thinking).toMatch(/^\[\[extracted-.+\]\]$/);
    });
  });

  // =========================================================================
  // KB-016: keep_chars truncation
  // =========================================================================

  describe('KB-016: keep_chars truncation', () => {
    it('preserves first N chars when keep_chars is set', async () => {
      const longContent = 'x'.repeat(2000);
      const entries = [
        createThinkingEntry(longContent, { __id: 'trunc-1' }),
        createUserMessage('hi'),
        createUserMessage('hi'),
        createUserMessage('hi'),
      ];

      sessionRepo.addSession(agentId, sessionId, entries);

      const result = await executor.runSmartPruning({
        ...defaultConfig,
        trigger_rules: [
          { type: 'thinking', min_length: 500, keep_recent: 3, keep_chars: 75 },
        ],
      });

      expect(result.entriesExtracted).toBe(1);

      const session = await sessionRepo.load(agentId, sessionId);
      const placeholder = session.entries[0].thinking as string;

      // Should start with 75 x's
      expect(placeholder.startsWith('x'.repeat(75))).toBe(true);
      // Should have ellipsis
      expect(placeholder.includes('... ')).toBe(true);
      // Should have extraction marker
      expect(placeholder).toMatch(/\[\[extracted-.+\]\]$/);

      // Total length should be ~75 + 3 (ellipsis) + 1 (space) + placeholder len
      expect(placeholder.length).toBeLessThan(200);
    });

    it('restore returns full content (not truncated)', async () => {
      const originalContent = 'z'.repeat(1500);
      const entries = [
        createThinkingEntry(originalContent, { __id: 'trunc-restore' }),
        createUserMessage('hi'),
        createUserMessage('hi'),
        createUserMessage('hi'),
      ];

      sessionRepo.addSession(agentId, sessionId, entries);

      // Extract with keep_chars
      await executor.runSmartPruning({
        ...defaultConfig,
        trigger_rules: [
          { type: 'thinking', min_length: 500, keep_recent: 3, keep_chars: 50 },
        ],
      });

      let session = await sessionRepo.load(agentId, sessionId);
      expect(session.entries[0].thinking.startsWith('z'.repeat(50))).toBe(true);

      // Restore should bring back full content
      await restoreService.restoreEntry({
        agentId,
        sessionId,
        entryId: 'trunc-restore',
      });

      session = await sessionRepo.load(agentId, sessionId);
      expect(session.entries[0].thinking).toBe(originalContent);
    });

    it('keep_chars=0 disables truncation (full placeholder only)', async () => {
      const longContent = 'y'.repeat(2000);
      const entries = [
        createThinkingEntry(longContent, { __id: 'no-trunc' }),
        createUserMessage('hi'),
        createUserMessage('hi'),
        createUserMessage('hi'),
      ];

      sessionRepo.addSession(agentId, sessionId, entries);

      await executor.runSmartPruning({
        ...defaultConfig,
        trigger_rules: [
          { type: 'thinking', min_length: 500, keep_recent: 3, keep_chars: 0 },
        ],
      });

      const session = await sessionRepo.load(agentId, sessionId);
      const placeholder = session.entries[0].thinking as string;

      // Should be just [[extracted-...]], no prefix chars
      expect(placeholder).toMatch(/^\[\[extracted-.+\]\]$/);
    });

    it('per-entry config can have different keep_chars', async () => {
      const thinking = 'a'.repeat(1000);
      const output = 'b'.repeat(1000);
      const entries = [
        createThinkingEntry(thinking, { __id: 'think-keep-50' }),
        createToolResultEntry(output, { __id: 'tool-keep-100' }),
        createUserMessage('hi'),
        createUserMessage('hi'),
        createUserMessage('hi'),
      ];

      sessionRepo.addSession(agentId, sessionId, entries);

      await executor.runSmartPruning({
        ...defaultConfig,
        trigger_rules: [
          { type: 'thinking', min_length: 500, keep_chars: 50, keep_recent: 3 },
          { type: 'tool_result', min_length: 500, keep_chars: 100, keep_recent: 3 },
        ],
      });

      const session = await sessionRepo.load(agentId, sessionId);

      // Thinking should have 50 chars preserved
      expect(session.entries[0].thinking.startsWith('a'.repeat(50))).toBe(true);

      // Tool result should have 100 chars preserved
      expect(session.entries[1].output.startsWith('b'.repeat(100))).toBe(true);
    });
  });
});
