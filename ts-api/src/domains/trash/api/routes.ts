import { Hono } from 'hono';
import type { TrashService } from '../services/trash-service.js';
import type { TrashedSession } from '../repository/trash-repository.js';

/** Map internal TrashedSession to Python API-compatible field names for the UI */
function mapTrashItem(s: TrashedSession) {
  return {
    original_session_id: s.id,
    original_agent: s.agentId,
    original_path: s.originalPath,
    trashed_at: new Date(s.deletedAt).toISOString(),
    expires_at: s.expiresAt,
    entry_count: s.entryCount,
  };
}

export function createTrashRoutes(trashService: TrashService): Hono {
  const app = new Hono();

  // GET /trash - List trashed sessions (Python API-compatible)
  app.get('/', async (c) => {
    const sessions = await trashService.list();
    return c.json({ sessions: sessions.map(mapTrashItem) });
  });

  // POST /trash/:agent/:id/restore
  app.post('/:agent/:id/restore', async (c) => {
    const agentId = c.req.param('agent');
    const sessionId = c.req.param('id');

    try {
      await trashService.restore(agentId, sessionId);
      return c.json({ restored: true, id: sessionId });
    } catch (error) {
      if (error instanceof Error && error.name === 'NotFoundError') {
        return c.json({ error: error.message }, 404);
      }
      throw error;
    }
  });

  // POST /trash/cleanup - Delete expired trash items
  app.post('/cleanup', async (c) => {
    const cleaned = await trashService.cleanup();
    return c.json({ cleaned });
  });

  // DELETE /trash/:agent/:id (permanent delete)
  app.delete('/:agent/:id', async (c) => {
    const agentId = c.req.param('agent');
    const sessionId = c.req.param('id');

    try {
      await trashService.deletePermanently(agentId, sessionId);
      return c.json({ deleted: true, id: sessionId });
    } catch (error) {
      if (error instanceof Error && error.name === 'NotFoundError') {
        return c.json({ error: error.message }, 404);
      }
      throw error;
    }
  });

  return app;
}
