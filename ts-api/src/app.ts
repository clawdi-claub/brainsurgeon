import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

// Infrastructure
import { SqliteMessageBus } from './infrastructure/bus/sqlite-bus.js';
import { ExternalStorage } from './infrastructure/external/storage.js';

// Config
const PORT = Number(process.env.PORT) || 8000;
const AGENTS_DIR = process.env.AGENTS_DIR || '/home/openclaw/.openclaw/agents';
const DATA_DIR = process.env.DATA_DIR || '/home/openclaw/.openclaw/brainsurgeon';

// Ensure directories exist
mkdirSync(DATA_DIR, { recursive: true });

// Initialize infrastructure
const messageBus = new SqliteMessageBus(join(DATA_DIR, 'bus.db'));

// Initialize domain services
const lockService = new OpenClawLockAdapter();
const sessionRepository = new FileSystemSessionRepository(AGENTS_DIR, lockService);
const sessionService = new SessionService(sessionRepository, lockService);
const externalStorage = new ExternalStorage({ sessionsDir: AGENTS_DIR });
const pruneService = new PruneService(sessionRepository, lockService, externalStorage);
const trashRepository = new FileSystemTrashRepository(AGENTS_DIR);
const trashService = new TrashService(trashRepository);

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

// Agents endpoint - returns list of agent IDs
apiApp.get('/agents', async (c) => {
  const sessions = await sessionService.listSessions();
  const agents = [...new Set(sessions.map(s => s.agentId))];
  return c.json(agents);
});

// Config endpoint
apiApp.get('/config', (c) => c.json({
  autoRefreshInterval: 10000,
  version: '2.0.0',
}));

// Restart endpoint
apiApp.post('/restart', async (c) => {
  setTimeout(() => process.exit(0), 100);
  return c.json({ success: true, message: 'Restarting...' });
});

// Error handler
apiApp.onError((err, c) => {
  console.error('Error:', err);
  return c.json({ error: 'Internal server error' }, 500);
});

// Main app mounts everything under /api
const app = new Hono();

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

// Mount API
app.route('/api', apiApp);
// Also mount at root for direct access
app.route('/', apiApp);

// Start message bus and server
async function main() {
  await messageBus.start();
  console.log('Message bus started');

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
