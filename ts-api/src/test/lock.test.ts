import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFile, mkdir, rm, access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { OpenClawLockAdapter } from '../domains/lock/adapters/openclaw-lock-adapter.js';

const TEMP_DIR = join(tmpdir(), 'brainsurgeon-test-' + randomUUID());

describe('OpenClawLockAdapter', () => {
  const adapter = new OpenClawLockAdapter();

  beforeAll(async () => {
    await mkdir(TEMP_DIR, { recursive: true });
  });

  afterAll(async () => {
    await rm(TEMP_DIR, { recursive: true, force: true });
  });

  it('acquires and releases lock', async () => {
    const sessionFile = join(TEMP_DIR, 'test.jsonl');
    await writeFile(sessionFile, 'test content', 'utf8');

    const lock = await adapter.acquire(sessionFile);

    // Verify lock file exists
    const lockPath = `${sessionFile}.lock`;
    await expect(access(lockPath)).resolves.toBeUndefined();

    // Release lock
    await lock.release();

    // Verify lock file removed
    await expect(access(lockPath)).rejects.toThrow();
  });

  it('returns isLocked=true when locked', async () => {
    const sessionFile = join(TEMP_DIR, 'test2.jsonl');
    await writeFile(sessionFile, 'test', 'utf8');

    expect(await adapter.isLocked(sessionFile)).toBe(false);

    const lock = await adapter.acquire(sessionFile);
    expect(await adapter.isLocked(sessionFile)).toBe(true);

    await lock.release();
    expect(await adapter.isLocked(sessionFile)).toBe(false);
  });

  it('lock file contains valid JSON', async () => {
    const sessionFile = join(TEMP_DIR, 'test3.jsonl');
    await writeFile(sessionFile, 'test', 'utf8');

    const lock = await adapter.acquire(sessionFile);

    const lockPath = `${sessionFile}.lock`;
    const content = await readFile(lockPath, 'utf8');
    const data = JSON.parse(content);

    expect(data).toHaveProperty('pid');
    expect(data).toHaveProperty('createdAt');
    expect(typeof data.pid).toBe('number');
    expect(typeof data.createdAt).toBe('string');

    await lock.release();
  });

  it('concurrent attempts wait for lock', async () => {
    const sessionFile = join(TEMP_DIR, 'test4.jsonl');
    await writeFile(sessionFile, 'test', 'utf8');

    const lock = await adapter.acquire(sessionFile);

    // Second acquire should timeout after many retries
    // We'll release before it times out
    setTimeout(() => lock.release(), 100);

    // This should eventually succeed after lock is released
    const lock2 = await adapter.acquire(sessionFile);
    await lock2.release();
  });
});
