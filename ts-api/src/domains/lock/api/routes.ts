import { Hono } from 'hono';
import { join } from 'node:path';
import type { LockService } from '../services/lock-service.js';

/** Map of held lock tokens: lockKey → release function */
const heldLocks = new Map<string, { release: () => Promise<void>; expiresAt: number }>();

/** Lock token TTL in ms — auto-release after this time */
const LOCK_TTL_MS = 30_000;

function lockKey(agent: string, sessionId: string): string {
  return `${agent}/${sessionId}`;
}

export function createLockRoutes(lockService: LockService, agentsDir: string): Hono {
  const app = new Hono();

  function resolveSessionFile(agent: string, sessionId: string): string {
    return join(agentsDir, agent, 'sessions', `${sessionId}.jsonl`);
  }

  // POST /lock/:agent/:id - Acquire lock
  app.post('/:agent/:id', async (c) => {
    const agent = c.req.param('agent');
    const sessionId = c.req.param('id');
    const key = lockKey(agent, sessionId);

    if (heldLocks.has(key)) {
      return c.json({ error: 'Lock already held', key }, 409);
    }

    try {
      const sessionFile = resolveSessionFile(agent, sessionId);
      const lock = await lockService.acquire(sessionFile);
      const expiresAt = Date.now() + LOCK_TTL_MS;

      // Auto-release on TTL
      const timeout = setTimeout(async () => {
        const held = heldLocks.get(key);
        if (held) {
          heldLocks.delete(key);
          await lock.release();
        }
      }, LOCK_TTL_MS);

      heldLocks.set(key, {
        release: async () => {
          clearTimeout(timeout);
          await lock.release();
        },
        expiresAt,
      });

      return c.json({ acquired: true, key, expiresAt });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Lock acquisition failed';
      return c.json({ error: message }, 503);
    }
  });

  // DELETE /lock/:agent/:id - Release lock
  app.delete('/:agent/:id', async (c) => {
    const agent = c.req.param('agent');
    const sessionId = c.req.param('id');
    const key = lockKey(agent, sessionId);

    const held = heldLocks.get(key);
    if (!held) {
      return c.json({ error: 'No lock held', key }, 404);
    }

    heldLocks.delete(key);
    await held.release();

    return c.json({ released: true, key });
  });

  // GET /lock/:agent/:id - Check lock status
  app.get('/:agent/:id', async (c) => {
    const agent = c.req.param('agent');
    const sessionId = c.req.param('id');
    const key = lockKey(agent, sessionId);

    const held = heldLocks.get(key);
    if (held) {
      return c.json({ locked: true, key, expiresAt: held.expiresAt });
    }

    return c.json({ locked: false, key });
  });

  return app;
}
