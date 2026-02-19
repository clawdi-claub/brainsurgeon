import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSystemSessionRepository } from '../domains/session/repository/session-repository.js';
import { OpenClawLockAdapter } from '../domains/lock/adapters/openclaw-lock-adapter.js';
import type { Session, SessionEntry } from '../domains/session/models/entry.js';

describe('SessionRepository sessions.json sync', () => {
  let tempDir: string;
  let repository: FileSystemSessionRepository;
  let lockService: OpenClawLockAdapter;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'bs-test-'));
    lockService = new OpenClawLockAdapter();
    repository = new FileSystemSessionRepository(tempDir, lockService);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should create sessions.json entry on save', async () => {
    const agentId = 'test-agent';
    const sessionId = 'test-session-1';
    
    const entries: SessionEntry[] = [
      {
        id: 'entry-1',
        type: 'message',
        role: 'user',
        content: [{ type: 'text', text: 'Hello' }],
        timestamp: Date.now(),
      },
    ];

    const session: Session = {
      id: sessionId,
      agentId,
      entries,
      metadata: {
        createdAt: Date.now(),
        updatedAt: Date.now(),
        entryCount: entries.length,
      },
    };

    await repository.save(agentId, sessionId, session);

    // Verify sessions.json was created
    const sessionsJsonPath = join(tempDir, agentId, 'sessions.json');
    expect(existsSync(sessionsJsonPath)).toBe(true);

    // Verify content
    const content = readFileSync(sessionsJsonPath, 'utf8');
    const data = JSON.parse(content);
    expect(data.sessions).toHaveLength(1);
    expect(data.sessions[0].id).toBe(sessionId);
    expect(data.sessions[0].agentId).toBe(agentId);
    expect(data.sessions[0].entryCount).toBe(1);
    expect(data.sessions[0].status).toBe('active');
  });

  it('should update existing sessions.json entry', async () => {
    const agentId = 'test-agent';
    const sessionId = 'test-session-1';
    
    // Save initial version
    const entries1: SessionEntry[] = [
      {
        id: 'entry-1',
        type: 'message',
        role: 'user',
        content: [{ type: 'text', text: 'Hello' }],
        timestamp: Date.now(),
      },
    ];

    await repository.save(agentId, sessionId, {
      id: sessionId,
      agentId,
      entries: entries1,
      metadata: {
        createdAt: Date.now(),
        updatedAt: Date.now(),
        entryCount: entries1.length,
      },
    });

    // Save updated version with more entries
    const entries2: SessionEntry[] = [
      ...entries1,
      {
        id: 'entry-2',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hi there' }],
        timestamp: Date.now(),
        model: 'test-model',
      },
    ];

    await repository.save(agentId, sessionId, {
      id: sessionId,
      agentId,
      entries: entries2,
      metadata: {
        createdAt: Date.now(),
        updatedAt: Date.now(),
        entryCount: entries2.length,
      },
    });

    // Verify sessions.json was updated
    const sessionsJsonPath = join(tempDir, agentId, 'sessions.json');
    const content = readFileSync(sessionsJsonPath, 'utf8');
    const data = JSON.parse(content);
    
    expect(data.sessions).toHaveLength(1);
    expect(data.sessions[0].entryCount).toBe(2);
    expect(data.sessions[0].modelsUsed).toContain('test-model');
  });

  it('should remove from sessions.json on delete', async () => {
    const agentId = 'test-agent';
    const sessionId = 'test-session-1';
    
    // Create session first
    const entries: SessionEntry[] = [
      {
        id: 'entry-1',
        type: 'message',
        role: 'user',
        content: [{ type: 'text', text: 'Hello' }],
        timestamp: Date.now(),
      },
    ];

    await repository.save(agentId, sessionId, {
      id: sessionId,
      agentId,
      entries,
      metadata: {
        createdAt: Date.now(),
        updatedAt: Date.now(),
        entryCount: entries.length,
      },
    });

    // Verify it exists
    const sessionsJsonPath = join(tempDir, agentId, 'sessions.json');
    let content = readFileSync(sessionsJsonPath, 'utf8');
    let data = JSON.parse(content);
    expect(data.sessions).toHaveLength(1);

    // Delete the session
    await repository.delete(agentId, sessionId);

    // Verify it's removed from sessions.json
    content = readFileSync(sessionsJsonPath, 'utf8');
    data = JSON.parse(content);
    expect(data.sessions).toHaveLength(0);
  });

  it('should list sessions from sessions.json', async () => {
    const agentId = 'test-agent';
    
    // Create multiple sessions
    for (let i = 1; i <= 3; i++) {
      const entries: SessionEntry[] = [
        {
          id: `entry-${i}`,
          type: 'message',
          role: 'user',
          content: [{ type: 'text', text: `Message ${i}` }],
          timestamp: Date.now() + i * 1000,
        },
      ];

      await repository.save(agentId, `session-${i}`, {
        id: `session-${i}`,
        agentId,
        entries,
        metadata: {
          createdAt: Date.now() + i * 1000,
          updatedAt: Date.now() + i * 1000,
          entryCount: entries.length,
        },
      });
    }

    // List sessions
    const sessions = await repository.list(agentId);
    expect(sessions).toHaveLength(3);
    
    // All 3 sessions should be present (ordering depends on write timing)
    const ids = sessions.map(s => s.id).sort();
    expect(ids).toEqual(['session-1', 'session-2', 'session-3']);
  });
});
