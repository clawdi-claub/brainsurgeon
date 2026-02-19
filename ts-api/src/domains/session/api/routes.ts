import { Hono } from 'hono';
import type { SessionService } from '../services/session-service.js';
import type { PruneService } from '../services/prune-service.js';

export function createSessionRoutes(
  sessionService: SessionService,
  pruneService: PruneService
): Hono {
  const app = new Hono();

  // GET /sessions?agent=&status=
  app.get('/', async (c) => {
    const agentId = c.req.query('agent');
    const status = c.req.query('status'); // not implemented yet
    
    const sessions = await sessionService.listSessions(agentId);
    
    if (status) {
      // Filter by status
      return c.json(sessions.filter(s => s.status === status));
    }
    
    return c.json(sessions);
  });

  // GET /sessions/:agent/:id
  app.get('/:agent/:id', async (c) => {
    const agentId = c.req.param('agent');
    const sessionId = c.req.param('id');
    
    try {
      const session = await sessionService.getSession(agentId, sessionId);
      return c.json(session);
    } catch (error) {
      if (error instanceof Error && error.name === 'NotFoundError') {
        return c.json({ error: error.message }, 404);
      }
      throw error;
    }
  });

  // GET /sessions/:agent/:id/summary
  app.get('/:agent/:id/summary', async (c) => {
    const agentId = c.req.param('agent');
    const sessionId = c.req.param('id');
    
    try {
      const summary = await sessionService.getSummary(agentId, sessionId);
      return c.json(summary);
    } catch (error) {
      if (error instanceof Error && error.name === 'NotFoundError') {
        return c.json({ error: error.message }, 404);
      }
      throw error;
    }
  });

  // POST /sessions/:agent/:id/prune
  app.post('/:agent/:id/prune', async (c) => {
    const agentId = c.req.param('agent');
    const sessionId = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    
    try {
      const result = await pruneService.execute(agentId, sessionId, {
        keepRecent: body.keepRecent,
        threshold: body.threshold,
      });
      return c.json(result);
    } catch (error) {
      if (error instanceof Error && error.name === 'NotFoundError') {
        return c.json({ error: error.message }, 404);
      }
      throw error;
    }
  });

  // DELETE /sessions/:agent/:id
  app.delete('/:agent/:id', async (c) => {
    const agentId = c.req.param('agent');
    const sessionId = c.req.param('id');
    
    try {
      await sessionService.deleteSession(agentId, sessionId);
      return c.json({ success: true });
    } catch (error) {
      if (error instanceof Error && error.name === 'NotFoundError') {
        return c.json({ error: error.message }, 404);
      }
      throw error;
    }
  });

  // PATCH /sessions/:agent/:id/entries/:entryId
  app.patch('/:agent/:id/entries/:entryId', async (c) => {
    const agentId = c.req.param('agent');
    const sessionId = c.req.param('id');
    const entryId = c.req.param('entryId');
    const body = await c.req.json().catch(() => ({}));
    
    try {
      await sessionService.editEntry(agentId, sessionId, entryId, body);
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
