import { Hono } from 'hono';
import type { SessionService } from '../services/session-service.js';
import type { PruneService } from '../services/prune-service.js';
import { mapSessionListItem, mapSessionDetail } from './response-mapper.js';

export function createSessionRoutes(
  sessionService: SessionService,
  pruneService: PruneService
): Hono {
  const app = new Hono();

  // GET /sessions?agent=&status=
  app.get('/', async (c) => {
    const agentId = c.req.query('agent');
    const status = c.req.query('status');

    let sessions = await sessionService.listSessions(agentId);

    if (status) {
      sessions = sessions.filter(s => s.status === status);
    }

    const mapped = sessions.map(mapSessionListItem);
    const agents = [...new Set(sessions.map(s => s.agentId))];
    const total_size = sessions.reduce((sum, s) => sum + (s.sizeBytes || 0), 0);

    return c.json({
      sessions: mapped,
      agents,
      total_size,
    });
  });

  // GET /sessions/:agent/:id
  app.get('/:agent/:id', async (c) => {
    const agentId = c.req.param('agent');
    const sessionId = c.req.param('id');

    try {
      const session = await sessionService.getSession(agentId, sessionId);
      return c.json(mapSessionDetail(
        session.id,
        session.agentId,
        session.entries,
        session.metadata,
        session.rawMeta
      ));
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
        keepRecent: body.keepRecent ?? body.keep_recent,
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

  // PUT /sessions/:agent/:id/entries/:index (Python API parity)
  app.put('/:agent/:id/entries/:index', async (c) => {
    const agentId = c.req.param('agent');
    const sessionId = c.req.param('id');
    const index = parseInt(c.req.param('index'), 10);
    const body = await c.req.json().catch(() => ({}));

    if (isNaN(index) || index < 0) {
      return c.json({ error: 'Invalid entry index' }, 400);
    }

    try {
      await sessionService.editEntryByIndex(agentId, sessionId, index, body.entry);
      return c.json({ updated: true, index });
    } catch (error) {
      if (error instanceof Error && error.name === 'NotFoundError') {
        return c.json({ error: error.message }, 404);
      }
      if (error instanceof Error && error.message.includes('Invalid entry index')) {
        return c.json({ error: error.message }, 400);
      }
      throw error;
    }
  });

  return app;
}
