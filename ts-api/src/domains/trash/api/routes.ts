import { Hono } from 'hono';
import type { TrashService } from '../services/trash-service.js';

export function createTrashRoutes(trashService: TrashService): Hono {
  const app = new Hono();

  // GET /trash - List trashed sessions
  app.get('/', async (c) => {
    const sessions = await trashService.list();
    return c.json(sessions);
  });

  // POST /trash/:agent/:id/restore
  app.post('/:agent/:id/restore', async (c) => {
    const agentId = c.req.param('agent');
    const sessionId = c.req.param('id');
    
    try {
      await trashService.restore(agentId, sessionId);
      return c.json({ success: true });
    } catch (error) {
      if (error instanceof Error && error.name === 'NotFoundError') {
        return c.json({ error: error.message }, 404);
      }
      throw error;
    }
  });

  // DELETE /trash/:agent/:id (permanent delete)
  app.delete('/:agent/:id', async (c) => {
    const agentId = c.req.param('agent');
    const sessionId = c.req.param('id');
    
    try {
      await trashService.deletePermanently(agentId, sessionId);
      return c.json({ success: true });
    } catch (error) {
      if (error instanceof Error && error.name === 'NotFoundError') {
        return c.json({ error: error.message }, 404);
      }
      throw error;
    }
  });

  return app;
}
