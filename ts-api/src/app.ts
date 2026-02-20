import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { cors } from 'hono/cors';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Logging
import { createLogger } from './shared/logging/logger.js';
const log = createLogger('app');

// Middleware
import { createAuthMiddleware } from './shared/middleware/auth.js';
import { createReadonlyMiddleware } from './shared/middleware/readonly.js';

// Domain - Lock
import { OpenClawLockAdapter } from './domains/lock/adapters/openclaw-lock-adapter.js';

// Domain - Session
import { FileSystemSessionRepository } from './domains/session/repository/session-repository.js';
import { SessionService } from './domains/session/services/session-service.js';
import { PruneService } from './domains/session/services/prune-service.js';
import { createSessionRoutes } from './domains/session/api/routes.js';

// Domain - Trash
import { FileSystemTrashRepository } from './domains/trash/repository/trash-repository.js';
import { TrashService } from './domains/trash/services/trash-service.js';
import { createTrashRoutes } from './domains/trash/api/routes.js';

// Domain - Lock API
import { createLockRoutes } from './domains/lock/api/routes.js';

// Domain - Config
import { FileSystemConfigRepository, BrainSurgeonConfigService } from './domains/config/index.js';

// Domain - Prune (Cron)
import { SmartPruningCronService } from './domains/prune/cron/cron-service.js';
import { SmartPruningExecutor } from './domains/prune/executor/pruning-executor.js';
import { createCronRoutes } from './domains/prune/api/cron-routes.js';
import { RestoreService } from './domains/prune/restore/restore-service.js';

// Infrastructure
import { SqliteMessageBus } from './infrastructure/bus/sqlite-bus.js';
import { ExternalStorage } from './infrastructure/external/storage.js';

// Config
const PORT = Number(process.env.PORT) || 8000;
const AGENTS_DIR = process.env.AGENTS_DIR || '/home/openclaw/.openclaw/agents';
const DATA_DIR = process.env.DATA_DIR || '/home/openclaw/.openclaw/brainsurgeon';
const API_KEYS = process.env.BRAINSURGEON_API_KEYS?.split(',').filter(Boolean) || [];
const READONLY = process.env.BRAINSURGEON_READONLY === 'true';
const CORS_ORIGINS = process.env.BRAINSURGEON_CORS_ORIGINS?.split(',') || [
  'http://localhost:8000',
  'http://127.0.0.1:8000',
];

// Ensure directories exist
mkdirSync(DATA_DIR, { recursive: true });

// Initialize infrastructure
const messageBus = new SqliteMessageBus(join(DATA_DIR, 'bus.db'));

// Initialize domain services
const lockService = new OpenClawLockAdapter();
const sessionRepository = new FileSystemSessionRepository(AGENTS_DIR, lockService);
const sessionService = new SessionService(sessionRepository, lockService, messageBus);
const externalStorage = new ExternalStorage({ sessionsDir: AGENTS_DIR });
const pruneService = new PruneService(sessionRepository, lockService, externalStorage, AGENTS_DIR);
const trashRepository = new FileSystemTrashRepository(AGENTS_DIR);
const trashService = new TrashService(trashRepository);
const configRepository = new FileSystemConfigRepository(AGENTS_DIR);
const configService = new BrainSurgeonConfigService(configRepository);

// Initialize extraction storage and pruning/cron services
import { ExtractionStorage } from './domains/prune/extraction/extraction-storage.js';
const extractionStorage = new ExtractionStorage({ agentsDir: AGENTS_DIR });
const pruningExecutor = new SmartPruningExecutor(AGENTS_DIR, sessionRepository);
const cronService = new SmartPruningCronService(configService, pruningExecutor);

// Initialize restore service
const restoreService = new RestoreService(extractionStorage, sessionRepository);

// Create Hono app with /api base path for backward compatibility
const apiApp = new Hono();

// Health check (available at both /health and /api/health)
apiApp.get('/health', (c) => c.json({ status: 'ok', version: '2.0.0' }));

// Mount session routes
const sessionRoutes = createSessionRoutes(sessionService, pruneService, extractionStorage, restoreService);
apiApp.route('/sessions', sessionRoutes);

// Mount trash routes
const trashRoutes = createTrashRoutes(trashService, extractionStorage, AGENTS_DIR);
apiApp.route('/trash', trashRoutes);

// Mount lock routes
const lockRoutes = createLockRoutes(lockService, AGENTS_DIR);
apiApp.route('/lock', lockRoutes);

// Mount cron routes
const cronRoutes = createCronRoutes(cronService, configService);
apiApp.route('/cron', cronRoutes);

// Agents endpoint - returns list of agent IDs (Python API-compatible format)
apiApp.get('/agents', async (c) => {
  const sessions = await sessionService.listSessions();
  const agents = [...new Set(sessions.map(s => s.agentId))].sort();
  return c.json({ agents });
});

// Config endpoints - Smart Pruning runtime config (not ENV vars)
apiApp.get('/config', async (c) => {
  try {
    const config = await configService.getConfig();
    return c.json(config);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

apiApp.post('/config', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const config = await configService.updateConfig(body);
    
    // Reload cron service if auto_cron or retention_cron changed
    if (body.auto_cron !== undefined || body.retention_cron !== undefined || body.enabled !== undefined) {
      const fullConfig = await configService.getFullConfig();
      await cronService.reloadConfig(fullConfig);
    }
    
    return c.json(config);
  } catch (err: any) {
    if (err.name === 'ValidationError') {
      return c.json({ error: err.message }, 400);
    }
    return c.json({ error: err.message }, 500);
  }
});

// Legacy config endpoint for ENV-based settings (readonly, auto_refresh_interval_ms)
apiApp.get('/config/env', (c) => c.json({
  auto_refresh_interval_ms: parseInt(process.env.AUTO_REFRESH_MS || '10000', 10),
  readonly_mode: READONLY,
}));

// Restart endpoint — calls openclaw gateway restart CLI
apiApp.post('/restart', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const delayMs = body.delay_ms || 5000;
  const note = body.note || 'Restart triggered from BrainSurgeon';

  // Try OpenClaw CLI first
  try {
    const { execSync } = await import('node:child_process');
    execSync('which openclaw', { timeout: 2000 });
    // openclaw is available, trigger restart
    import('node:child_process').then(({ exec }) => {
      exec(`openclaw gateway restart`, { timeout: 10000 });
    });
    return c.json({ restarted: true, delay_ms: delayMs, note });
  } catch {
    // Fallback for containerized environments
    return c.json({
      restarted: true,
      simulated: true,
      delay_ms: delayMs,
      note,
      message: 'Restart command received. When running in container, restart must be performed on host.',
    });
  }
});

// Event endpoints for OpenClaw extension integration
apiApp.post('/events/message-written', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  
  // Store event in message bus
  await messageBus.publish('session.updated', {
    agentId: body.agentId || body.agent,
    sessionId: body.sessionId || body.session,
    entryCount: body.entryCount || body.entryIndex,
    lastEntryType: body.entryType || 'message',
    timestamp: body.timestamp || new Date().toISOString(),
  });
  
  return c.json({ received: true, event: 'message_written' });
});

apiApp.post('/events/session-created', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  
  await messageBus.publish('session.updated', {  // Use existing type
    agentId: body.agentId || body.agent,
    sessionId: body.sessionId || body.session,
    entryCount: 0,
    lastEntryType: 'session_created',
    timestamp: body.timestamp || new Date().toISOString(),
  });
  
  return c.json({ received: true, event: 'session_created' });
});

apiApp.post('/events/entry-restored', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  
  await messageBus.publish('restore.response', {
    agentId: body.agentId,
    sessionId: body.sessionId,
    toolCallId: body.toolcallid,
    success: true,
    timestamp: body.timestamp || new Date().toISOString(),
  });
  
  return c.json({ received: true, event: 'entry_restored' });
});

// Error handler
apiApp.onError((err, c) => {
  log.error({ err }, 'unhandled request error');
  return c.json({ error: 'Internal server error' }, 500);
});

// Main app mounts everything under /api
const app = new Hono();

// Apply CORS middleware to all routes
app.use('*', cors({ origin: CORS_ORIGINS, credentials: true }));

// API app with auth and readonly middleware
const apiAppWithMiddleware = new Hono();

// Apply auth and readonly middleware to API routes
apiAppWithMiddleware.use('*', createAuthMiddleware(API_KEYS));
apiAppWithMiddleware.use('*', createReadonlyMiddleware(READONLY));

// Mount the original apiApp
apiAppWithMiddleware.route('/', apiApp);

// Static files - serve web frontend
const __dirname = dirname(fileURLToPath(import.meta.url));
// In dev: ts-api/dist/app.js -> ts-api/../web = project-root/web
// In container: /app/dist/app.js -> /app/web (Dockerfile copies web to /app/web)
const webDir = process.env.WEB_DIR || (process.env.NODE_ENV === 'production'
  ? join(__dirname, '..', 'web')  // container: /app/dist/../web = /app/web
  : join(__dirname, '..', '..', 'web'));  // dev: ts-api/dist/../../web = project-root/web

// Helper to read file safely
function serveStatic(filename: string) {
  const path = join(webDir, filename);
  if (!existsSync(path)) return new Response('Not Found', { status: 404 });
  return new Response(readFileSync(path), {
    headers: { 'Content-Type': getContentType(filename) },
  });
}

function getContentType(filename: string): string {
  if (filename.endsWith('.html')) return 'text/html';
  if (filename.endsWith('.js')) return 'application/javascript';
  if (filename.endsWith('.css')) return 'text/css';
  return 'text/plain';
}

// Serve static files from web directory
app.get('/', c => serveStatic('index.html'));
app.get('/index.html', c => serveStatic('index.html'));
app.get('/app.js', c => serveStatic('app.js'));
app.get('/styles.css', c => serveStatic('styles.css'));

// Public endpoint: auth status (before auth middleware)
app.get('/api/auth-info', (c) => c.json({ auth_required: API_KEYS.length > 0 }));

// Mount API (with middleware)
app.route('/api', apiAppWithMiddleware);
// Also mount at root for direct access (with middleware)
app.route('/', apiAppWithMiddleware);

// Start message bus, cron service, and server
async function main() {
  // Subscribe to messages from extension via bus
  messageBus.subscribe('message_written', async (msg) => {
    log.debug({ payload: msg.payload }, 'bus: message_written received');
  });

  messageBus.subscribe('session.created', async (msg) => {
    log.debug({ payload: msg.payload }, 'bus: session.created received');
  });

  messageBus.subscribe('prune.request', async (msg) => {
    const { agentId, sessionId, threshold } = msg.payload as any;
    log.debug({ agentId, sessionId, threshold }, 'bus: prune.request received');
    try {
      const result = await pruneService.execute(agentId, sessionId, { threshold });
      await messageBus.publish('prune.response', {
        agentId,
        sessionId,
        externalized: result.externalized ?? 0,
        success: true,
      });
    } catch (err: any) {
      log.error({ err, agentId, sessionId }, 'prune.request handler failed');
      await messageBus.publish('prune.response', {
        agentId,
        sessionId,
        externalized: 0,
        success: false,
        error: err.message,
      });
    }
  });

  messageBus.subscribe('restore.request', async (msg) => {
    const { agentId, sessionId, entryId, keys } = msg.payload as any;
    log.debug({ agentId, sessionId, entryId }, 'bus: restore.request received');
    try {
      const session = await sessionService.getSession(agentId, sessionId);
      const entry = session.entries.find((e: any) => e.__id === entryId || e.id === entryId);
      if (!entry) throw new Error(`Entry ${entryId} not found`);

      // Read extracted data
      const extractedPath = join(AGENTS_DIR, agentId, 'sessions', 'extracted', sessionId, `${entryId}.jsonl`);
      const { readFile } = await import('node:fs/promises');
      const extractedContent = await readFile(extractedPath, 'utf-8');
      const extractedData = JSON.parse(extractedContent);

      const keysToRestore = keys || Object.keys(extractedData).filter((k: string) => !k.startsWith('__'));
      const restoredKeys: string[] = [];

      // Restore extracted values into entry
      function restoreInObject(obj: any, pathPrefix: string[] = []): void {
        for (const key of Object.keys(obj)) {
          const fullPath = [...pathPrefix, key];
          if (obj[key] === '[[extracted]]') {
            let val = extractedData;
            for (const p of fullPath) { if (val && typeof val === 'object') val = val[p]; else { val = undefined; break; } }
            if (val !== undefined) { obj[key] = val; restoredKeys.push(fullPath.join('.')); }
          } else if (typeof obj[key] === 'object' && obj[key] !== null) {
            restoreInObject(obj[key], fullPath);
          }
        }
      }
      restoreInObject(entry);
      (entry as any).__restored_at = new Date().toISOString();
      (entry as any).__restored_keys = restoredKeys;

      // Save session (uses API lock adapter)
      await sessionService.editEntry(agentId, sessionId, entryId, entry);

      await messageBus.publish('restore.response', {
        agentId, sessionId, toolCallId: entryId, success: true, restoredKeys,
      });
      log.info({ agentId, sessionId, entryId, count: restoredKeys.length }, 'restore completed');
    } catch (err: any) {
      log.error({ err, agentId, sessionId, entryId }, 'restore.request handler failed');
      await messageBus.publish('restore.response', {
        agentId, sessionId, toolCallId: entryId, success: false, error: err.message,
      });
    }
  });

  await messageBus.start();
  log.info('message bus started');

  // Start cron service for smart pruning
  await cronService.start();

  // Run retention cleanup on startup (SP-07 requirement)
  try {
    const startupConfig = await configService.getFullConfig();
    const retentionResult = await pruningExecutor.runRetentionCleanup(startupConfig.retention);
    if (retentionResult.filesDeleted > 0) {
      log.info({
        filesDeleted: retentionResult.filesDeleted,
        bytesReclaimed: retentionResult.bytesReclaimed,
      }, 'startup retention cleanup completed');
    }
  } catch (err: any) {
    log.warn({ err: err.message }, 'startup retention cleanup failed (non-fatal)');
  }

  serve({
    fetch: app.fetch,
    port: PORT,
  });

  log.info({ port: PORT }, 'BrainSurgeon API running');
}

main().catch((err) => log.fatal({ err }, 'startup failed'));

// Graceful shutdown
process.on('SIGTERM', async () => {
  log.info('SIGTERM received, shutting down gracefully');
  await cronService.stop();
  await messageBus.stop();
  log.info('shutdown complete');
  process.exit(0);
});

process.on('SIGINT', async () => {
  log.info('SIGINT received, shutting down gracefully');
  await cronService.stop();
  await messageBus.stop();
  log.info('shutdown complete');
  process.exit(0);
});
