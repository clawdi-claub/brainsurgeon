import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { cors } from 'hono/cors';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

// Initialize pruning and cron services
const pruningExecutor = new SmartPruningExecutor(AGENTS_DIR);
const cronService = new SmartPruningCronService(configService, pruningExecutor);

// Create Hono app with /api base path for backward compatibility
const apiApp = new Hono();

// Health check (available at both /health and /api/health)
apiApp.get('/health', (c) => c.json({ status: 'ok', version: '2.0.0' }));

// Mount session routes
const sessionRoutes = createSessionRoutes(sessionService, pruneService);
apiApp.route('/sessions', sessionRoutes);

// Mount trash routes
const trashRoutes = createTrashRoutes(trashService);
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
  console.error('Error:', err);
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
const webDir = join(__dirname, '..', '..', 'web');

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

// Mount API (with middleware)
app.route('/api', apiAppWithMiddleware);
// Also mount at root for direct access (with middleware)
app.route('/', apiAppWithMiddleware);

// Start message bus, cron service, and server
async function main() {
  await messageBus.start();
  console.log('Message bus started');

  // Start cron service for smart pruning
  await cronService.start();

  serve({
    fetch: app.fetch,
    port: PORT,
  });

  console.log(`BrainSurgeon API running on port ${PORT}`);
}

main().catch(console.error);

// Graceful shutdown
process.on('SIGTERM', async () => {
  await messageBus.stop();
  process.exit(0);
});

process.on('SIGINT', async () => {
  await messageBus.stop();
  process.exit(0);
});
