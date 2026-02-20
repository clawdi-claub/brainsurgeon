import { Hono } from 'hono';
import type { TrashService } from '../services/trash-service.js';
import type { TrashedSession } from '../repository/trash-repository.js';
import type { ExtractionStorage } from '../../prune/extraction/extraction-storage.js';
import { restoreExtractedFromTrash, deleteExtractedFromTrash } from '../../prune/extraction/extraction-trash.js';
import { createLogger } from '../../../shared/logging/logger.js';

const log = createLogger('trash-routes');

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

export function createTrashRoutes(
  trashService: TrashService,
  extractionStorage?: ExtractionStorage,
  agentsDir?: string,
): Hono {
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

      // Also restore extracted files from trash (SP-08)
      if (extractionStorage) {
        try {
          const restored = await restoreExtractedFromTrash(extractionStorage, agentId, sessionId);
          if (restored) {
            log.info({ agentId, sessionId }, 'restored extracted files from trash');
          }
        } catch (err) {
          log.warn({ agentId, sessionId, err }, 'failed to restore extracted files (non-fatal)');
        }
      }

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

      // Also permanently delete extracted files (SP-08)
      if (extractionStorage && agentsDir) {
        try {
          // Delete from both trash and live extracted dirs
          await deleteExtractedFromTrash(agentsDir, agentId, sessionId);
          await extractionStorage.deleteAll(agentId, sessionId);
        } catch (err) {
          log.warn({ agentId, sessionId, err }, 'failed to delete extracted files (non-fatal)');
        }
      }

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
