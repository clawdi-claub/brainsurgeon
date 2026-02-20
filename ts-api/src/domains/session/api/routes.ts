import { Hono } from 'hono';
import type { SessionService } from '../services/session-service.js';
import type { PruneService } from '../services/prune-service.js';
import type { ExtractionStorage } from '../../prune/extraction/extraction-storage.js';
import { moveExtractedToTrash } from '../../prune/extraction/extraction-trash.js';
import { mapSessionListItem, mapSessionDetail } from './response-mapper.js';
import { generateSessionSummary } from '../services/summary-service.js';
import { sanitizeId } from '../../../shared/middleware/sanitize.js';
import { auditLog } from '../../../shared/logging/audit.js';
import { createLogger } from '../../../shared/logging/logger.js';

const log = createLogger('session-routes');

export function createSessionRoutes(
  sessionService: SessionService,
  pruneService: PruneService,
  extractionStorage?: ExtractionStorage,
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
    const agentId = sanitizeId(c.req.param('agent'), 'agent');
    const sessionId = sanitizeId(c.req.param('id'), 'session_id');

    try {
      const session = await sessionService.getSession(agentId, sessionId);
      return c.json(mapSessionDetail(
        session.id,
        session.agentId,
        session.entries,
        session.metadata,
        session.rawMeta,
        session.children,
      ));
    } catch (error) {
      if (error instanceof Error && error.name === 'NotFoundError') {
        return c.json({ error: error.message }, 404);
      }
      throw error;
    }
  });

  // GET /sessions/:agent/:id/summary — Python API-compatible rich summary
  app.get('/:agent/:id/summary', async (c) => {
    const agentId = sanitizeId(c.req.param('agent'), 'agent');
    const sessionId = sanitizeId(c.req.param('id'), 'session_id');

    try {
      const session = await sessionService.getSession(agentId, sessionId);
      const summary = generateSessionSummary(session.entries);
      return c.json({
        session_id: sessionId,
        agent: agentId,
        summary,
        generated_at: new Date().toISOString(),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'NotFoundError') {
        return c.json({ error: error.message }, 404);
      }
      throw error;
    }
  });

  // POST /sessions/:agent/:id/prune
  app.post('/:agent/:id/prune', async (c) => {
    const agentId = sanitizeId(c.req.param('agent'), 'agent');
    const sessionId = sanitizeId(c.req.param('id'), 'session_id');
    const body = await c.req.json().catch(() => ({}));

    const keepRecent = body.keepRecent ?? body.keep_recent;
    auditLog('prune', agentId, sessionId, c.req.header('X-API-Key'), { keep_recent: keepRecent });

    try {
      const result = await pruneService.execute(agentId, sessionId, {
        keepRecent,
        threshold: body.threshold,
      });
      // Python API-compatible response fields
      return c.json({
        pruned: result.pruned_count > 0,
        entries_pruned: result.pruned_count,
        original_size: result.original_size,
        new_size: result.new_size,
        saved_bytes: result.original_size - result.new_size,
        mode: keepRecent === -1 ? 'light' : 'full',
      });
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
      // Publish compact.request to message bus
      // Extension subscribes and triggers OpenClaw compaction
      await sessionService.publishEvent?.('compact.request', {
        agentId,
        sessionId,
        instructions: body.instructions,
        triggeredBy: 'webui',
      });
      
      log.debug({ agentId, sessionId }, 'compact.request published to bus');

      return c.json({
        success: true,
        message: 'Compaction request queued. Extension will process via message bus.',
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

  // GET /sessions/:agent/:id/entries/:entryId/extracted — fetch extracted content
  app.get('/:agent/:id/entries/:entryId/extracted', async (c) => {
    const agentId = sanitizeId(c.req.param('agent'), 'agent');
    const sessionId = sanitizeId(c.req.param('id'), 'session_id');
    const entryId = c.req.param('entryId');

    if (!extractionStorage) {
      return c.json({ error: 'Extraction storage not configured' }, 501);
    }

    try {
      const data = await extractionStorage.read(agentId, sessionId, entryId);
      if (!data) {
        return c.json({ error: 'Extracted content not found' }, 404);
      }

      const { __meta, ...content } = data;
      const size = await extractionStorage.sessionSize(agentId, sessionId);

      return c.json({
        entryId,
        agent: agentId,
        session: sessionId,
        content,
        meta: __meta || null,
        sizeBytes: JSON.stringify(data).length,
        sessionExtracted: size,
      });
    } catch (error) {
      log.error({ err: error, agentId, sessionId, entryId }, 'failed to read extracted content');
      return c.json({ error: 'Failed to read extracted content' }, 500);
    }
  });

  // DELETE /sessions/:agent/:id — moves to trash, also deletes child sessions + extracted files
  app.delete('/:agent/:id', async (c) => {
    const agentId = sanitizeId(c.req.param('agent'), 'agent');
    const sessionId = sanitizeId(c.req.param('id'), 'session_id');

    auditLog('delete', agentId, sessionId, c.req.header('X-API-Key'));

    try {
      // Find children before deleting (Python API parity: delete child sessions too)
      const children = await sessionService['sessionRepo'].findChildren(agentId, sessionId);

      await sessionService.deleteSession(agentId, sessionId);

      // Move extracted files to trash (SP-08)
      let extractedFileCount = 0;
      if (extractionStorage) {
        try {
          const size = await extractionStorage.sessionSize(agentId, sessionId);
          extractedFileCount = size.files;
          if (size.files > 0) {
            // Move extracted dir to trash location alongside .jsonl
            await moveExtractedToTrash(extractionStorage, agentId, sessionId);
            auditLog('delete_extracted', agentId, sessionId, c.req.header('X-API-Key'), {
              filesRemoved: size.files,
              bytesRemoved: size.bytes,
            });
          }
        } catch (err) {
          log.warn({ agentId, sessionId, err }, 'failed to move extracted files to trash (non-fatal)');
        }
      }

      // Also delete child sessions + their extracted files
      for (const child of children) {
        try {
          await sessionService.deleteSession(agentId, child.sessionId);
          if (extractionStorage) {
            try {
              const childSize = await extractionStorage.sessionSize(agentId, child.sessionId);
              if (childSize.files > 0) {
                await moveExtractedToTrash(extractionStorage, agentId, child.sessionId);
              }
            } catch { /* non-fatal */ }
          }
          auditLog('delete_child', agentId, child.sessionId, c.req.header('X-API-Key'), { parent: sessionId });
        } catch {
          // Don't fail if child doesn't exist
        }
      }

      return c.json({
        deleted: true,
        id: sessionId,
        moved_to_trash: true,
        children_deleted: children.length,
        extracted_files_trashed: extractedFileCount,
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
    const agentId = sanitizeId(c.req.param('agent'), 'agent');
    const sessionId = sanitizeId(c.req.param('id'), 'session_id');
    const index = parseInt(c.req.param('index'), 10);
    const body = await c.req.json().catch(() => ({}));

    if (isNaN(index) || index < 0) {
      return c.json({ error: 'Invalid entry index' }, 400);
    }

    auditLog('edit_entry', agentId, sessionId, c.req.header('X-API-Key'), { index });

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
