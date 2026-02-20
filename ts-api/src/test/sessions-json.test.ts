import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSystemSessionRepository } from '../domains/session/repository/session-repository.js';
import { OpenClawLockAdapter } from '../domains/lock/adapters/openclaw-lock-adapter.js';

describe('SessionRepository with OpenClaw file structure', () => {
  let agentsDir: string;
  let repository: FileSystemSessionRepository;
  let lockService: OpenClawLockAdapter;

  beforeEach(() => {
    agentsDir = mkdtempSync(join(tmpdir(), 'bs-agents-'));
    lockService = new OpenClawLockAdapter();
    repository = new FileSystemSessionRepository(agentsDir, lockService);
  });

  afterEach(() => {
    rmSync(agentsDir, { recursive: true, force: true });
  });

  it('should list agents by scanning directories', async () => {
    mkdirSync(join(agentsDir, 'agent-a', 'sessions'), { recursive: true });
    mkdirSync(join(agentsDir, 'agent-b', 'sessions'), { recursive: true });

    const sessions = await repository.list();
    // No sessions.json yet so empty, but agents exist
    expect(sessions).toHaveLength(0);
  });

  it('should list sessions from OpenClaw map-format sessions.json', async () => {
    const agentId = 'test-agent';
    const sessionsDir = join(agentsDir, agentId, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });

    // Write OpenClaw-format sessions.json (map of key -> metadata)
    const sessionsJson = {
      'agent:test-agent:direct:123': {
        sessionId: 'sess-aaa',
        updatedAt: 1700000000000,
        chatType: 'direct',
        origin: { label: 'Test User' },
      },
      'agent:test-agent:direct:456': {
        sessionId: 'sess-bbb',
        updatedAt: 1700001000000,
        chatType: 'direct',
        origin: { label: 'Other User' },
      },
    };

    writeFileSync(join(sessionsDir, 'sessions.json'), JSON.stringify(sessionsJson));

    // Create corresponding JSONL files (listing skips sessions without files)
    writeFileSync(join(sessionsDir, 'sess-aaa.jsonl'), JSON.stringify({ type: 'message', message: { role: 'user', content: 'hi' } }) + '\n');
    writeFileSync(join(sessionsDir, 'sess-bbb.jsonl'), JSON.stringify({ type: 'message', message: { role: 'user', content: 'hello' } }) + '\n');

    const sessions = await repository.list(agentId);
    expect(sessions).toHaveLength(2);

    // Should be sorted by updatedAt descending
    expect(sessions[0].id).toBe('sess-bbb');
    expect(sessions[1].id).toBe('sess-aaa');
    expect(sessions[0].title).toBe('Other User');
  });

  it('should load a session from JSONL file', async () => {
    const agentId = 'test-agent';
    const sessionId = 'test-session';
    const sessionsDir = join(agentsDir, agentId, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });

    // Write a JSONL session file
    const entries = [
      { id: 'e1', type: 'message', role: 'user', content: [{ type: 'text', text: 'Hello' }], timestamp: 1700000000000 },
      { id: 'e2', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Hi' }], timestamp: 1700000001000, model: 'test-model' },
    ];

    const jsonl = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
    writeFileSync(join(sessionsDir, `${sessionId}.jsonl`), jsonl);

    const session = await repository.load(agentId, sessionId);
    expect(session.entries).toHaveLength(2);
    expect(session.agentId).toBe(agentId);
    expect(session.id).toBe(sessionId);
  });

  it('should remove session from sessions.json on delete', async () => {
    const agentId = 'test-agent';
    const sessionId = 'test-session';
    const sessionsDir = join(agentsDir, agentId, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });

    // Create trash dir
    mkdirSync(join(agentsDir, '.trash', agentId), { recursive: true });

    // Write session file
    writeFileSync(
      join(sessionsDir, `${sessionId}.jsonl`),
      JSON.stringify({ id: 'e1', type: 'message', role: 'user', content: [{ type: 'text', text: 'test' }], timestamp: Date.now() }) + '\n'
    );

    // Write sessions.json with the session
    const sessionsJson = {
      'agent:test-agent:direct:123': {
        sessionId: sessionId,
        updatedAt: Date.now(),
      },
      'agent:test-agent:direct:456': {
        sessionId: 'other-session',
        updatedAt: Date.now(),
      },
    };
    writeFileSync(join(sessionsDir, 'sessions.json'), JSON.stringify(sessionsJson));

    // Delete the session
    await repository.delete(agentId, sessionId);

    // Verify it was removed from sessions.json
    const content = readFileSync(join(sessionsDir, 'sessions.json'), 'utf8');
    const data = JSON.parse(content);

    // Only the other session should remain
    const keys = Object.keys(data);
    expect(keys).toHaveLength(1);
    expect(data['agent:test-agent:direct:456'].sessionId).toBe('other-session');

    // Verify file was moved to trash
    expect(existsSync(join(sessionsDir, `${sessionId}.jsonl`))).toBe(false);
    expect(existsSync(join(agentsDir, '.trash', agentId, `${sessionId}.jsonl`))).toBe(true);
  });
});
