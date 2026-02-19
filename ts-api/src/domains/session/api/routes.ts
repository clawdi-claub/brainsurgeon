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

  // POST /sessions/:agent/:id/compact
  app.post('/:agent/:id/compact', async (c) => {
    const agentId = c.req.param('agent');
    const sessionId = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));

    try {
      // Forward to extension to trigger OpenClaw compaction
      // Extension listens on a well-known route or uses plugin API
      
      // For now, we store a compaction request in the message bus
      // The extension or OpenClaw can pick this up
      await sessionService.publishEvent?.('session.compacted', {
        agentId,
        sessionId,
        instructions: body.instructions,
        triggeredAt: new Date().toISOString(),
      });
      
      // Also forward to extension if configured
      const extensionUrl = process.env.BRAINSURGEON_EXTENSION_URL || 'http://localhost:8654';
      try {
        const response = await fetch(`${extensionUrl}/trigger-compact`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId,
            sessionId,
            instructions: body.instructions,
          }),
        });
        
        if (response.ok) {
          const result = await response.json();
          return c.json({
            success: true,
            message: 'OpenClaw compaction triggered via extension',
            details: result,
            agent: agentId,
            session: sessionId,
          });
        }
      } catch (extError) {
        // Extension not available, continue with message bus approach
        console.log('Extension not available for compaction, using message bus');
      }

      return c.json({
        success: true,
        message: 'Compaction request queued. OpenClaw will process when available.',
        agent: agentId,
        session: sessionId,
        instructions: body.instructions,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'NotFoundError') {
        return c.json({ error: error.message }, 404);
      }
      throw error;
    }
  });

  // POST /sessions/:agent/:id/prune/smart - Smart live prune
  app.post('/:agent/:id/prune/smart', async (c) => {
    const agentId = c.req.param('agent');
    const sessionId = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));

    try {
      const result = await pruneService.smartLivePrune(
        agentId,
        sessionId,
        body.threshold ?? 3
      );
      
      if (!result) {
        return c.json({ pruned: 0, message: 'No entries met pruning threshold' });
      }
      
      return c.json({
        pruned: result.pruned,
        externalized: result.externalized,
        message: `Smart prune completed: ${result.pruned} entries externalized`
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'NotFoundError') {
        return c.json({ error: error.message }, 404);
      }
      throw error;
    }
  });

  // POST /sessions/:agent/:id/prune/enhanced - Enhanced prune
  app.post('/:agent/:id/prune/enhanced', async (c) => {
    const agentId = c.req.param('agent');
    const sessionId = c.req.param('id');

    try {
      const result = await pruneService.enhancedPrune(agentId, sessionId);
      
      return c.json({
        pruned: result.pruned,
        byType: result.byType,
        message: `Enhanced prune completed: ${result.pruned} entries pruned`
      });
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
