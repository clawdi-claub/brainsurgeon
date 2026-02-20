import { Type } from '@sinclair/typebox';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

// Full OpenClaw Plugin API interface (provided by OpenClaw at runtime)
interface PluginApi {
  id: string;
  name: string;
  version?: string;
  description?: string;
  config: {
    agentsDir?: string;
    apiUrl?: string;
    enableAutoPrune?: boolean;
    autoPruneThreshold?: number;
    keepRestoreRemoteCalls?: boolean;
    busDbPath?: string;
  };
  registerTool: (tool: ToolDefinition) => void;
  registerCommand: (command: CommandDefinition) => void;
  registerHttpRoute: (params: { path: string; handler: (req: any, res: any) => void | Promise<void> }) => void;
  on: (event: string, handler: (event: any) => void | Promise<void>) => void;
  emit: (event: string, data: any) => void;
  log: {
    info: (msg: string) => void;
    error: (msg: string, err?: Error) => void;
    debug: (msg: string) => void;
  };
}

interface ToolDefinition {
  name: string;
  description: string;
  parameters: any;
  execute: (id: string, params: any) => Promise<any>;
}

interface CommandDefinition {
  name: string;
  description: string;
  aliases?: string[];
  handler: (ctx: CommandContext) => Promise<CommandResult> | CommandResult;
}

interface CommandContext {
  agentId?: string;
  sessionId?: string;
  args: string[];
  prompt?: string;
}

interface CommandResult {
  success: boolean;
  message?: string;
  error?: string;
}

// ── Lightweight message bus client (node:sqlite) ──────────────────────
// Same schema as ts-api/src/infrastructure/bus/sqlite-bus.ts.
// Extension and API share the same bus.db via WAL-mode SQLite.
// Pattern matches OpenClaw's default memory provider:
// https://github.com/openclaw/openclaw/blob/main/src/memory/sqlite.ts

const _require = createRequire(import.meta.url);
const { DatabaseSync } = _require('node:sqlite') as typeof import('node:sqlite');

type MessageType = string;
interface BusMessage { id: string; type: string; payload: unknown; timestamp: number; source: string; }
type BusHandler = (msg: BusMessage) => void | Promise<void>;

class ExtensionBus {
  private db: InstanceType<typeof DatabaseSync> | null = null;
  private handlers = new Map<MessageType, Set<BusHandler>>();
  private pollTimer: NodeJS.Timeout | null = null;

  open(dbPath: string): void {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT NOT NULL,
        timestamp INTEGER NOT NULL, source TEXT NOT NULL,
        processed INTEGER NOT NULL DEFAULT 0, processed_at INTEGER,
        retry_count INTEGER NOT NULL DEFAULT 0, error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_messages_processed ON messages(processed);
    `);
    this.db.exec('PRAGMA journal_mode=WAL');
  }

  publish(type: MessageType, payload: unknown): void {
    if (!this.db) return;
    const id = randomUUID();
    this.db.prepare(
      'INSERT INTO messages (id,type,payload,timestamp,source,processed) VALUES (?,?,?,?,?,0)'
    ).run(id, type, JSON.stringify(payload), Date.now(), 'extension');
    api?.log.debug(`bus: published ${type} (${id})`);
  }

  subscribe(type: MessageType, handler: BusHandler): void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(handler);
  }

  start(intervalMs = 200): void {
    this.poll(); // replay on start
    this.pollTimer = setInterval(() => this.poll(), intervalMs);
  }

  stop(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.db) { this.db.close(); this.db = null; }
  }

  private poll(): void {
    if (!this.db) return;
    const rows = this.db.prepare(
      `SELECT id,type,payload,timestamp,source FROM messages
       WHERE processed=0 AND retry_count<3 ORDER BY timestamp ASC`
    ).all() as unknown as Array<{ id: string; type: string; payload: string; timestamp: number; source: string }>;

    for (const row of rows) {
      const handlers = this.handlers.get(row.type);
      if (!handlers || handlers.size === 0) {
        // Not our message type — leave for the API to process
        continue;
      }
      const msg: BusMessage = { ...row, payload: JSON.parse(row.payload) };
      for (const h of handlers) {
        try { h(msg); } catch (err: any) {
          api?.log.error(`bus handler error for ${row.type}: ${err.message}`);
          this.db!.prepare('UPDATE messages SET retry_count=retry_count+1, error=? WHERE id=?')
            .run(String(err).slice(0, 1000), row.id);
        }
      }
      this.db.prepare('UPDATE messages SET processed=1, processed_at=? WHERE id=?')
        .run(Date.now(), row.id);
    }
  }
}

const bus = new ExtensionBus();

// Global API reference (set during activate)
let api: PluginApi | null = null;

/**
 * Lock file utilities - OpenClaw-compatible file locking
 */
async function acquireLock(lockFile: string, maxWaitMs = 30000): Promise<void> {
  const startTime = Date.now();
  const pid = process.pid;
  const lockContent = JSON.stringify({ pid, createdAt: new Date().toISOString() });

  while (Date.now() - startTime < maxWaitMs) {
    try {
      // Try to create lock file with exclusive flag
      await fs.writeFile(lockFile, lockContent, { flag: 'wx' });
      api?.log.debug(`Lock acquired: ${lockFile}`);
      return;
    } catch (err: any) {
      if (err.code === 'EEXIST') {
        // Lock exists - check if stale
        try {
          const content = await fs.readFile(lockFile, 'utf-8');
          const lock = JSON.parse(content);
          const lockAge = Date.now() - new Date(lock.createdAt).getTime();
          
          // Stale lock detection (30 minutes)
          if (lockAge > 30 * 60 * 1000) {
            api?.log.info(`Removing stale lock: ${lockFile} (age: ${Math.round(lockAge / 1000)}s)`);
            await fs.unlink(lockFile).catch(() => {});
            continue;
          }
        } catch {
          // Corrupted lock - remove it
          await fs.unlink(lockFile).catch(() => {});
          continue;
        }
        
        // Wait with exponential backoff
        const wait = Math.min(1000, 50 * Math.pow(2, (Date.now() - startTime) / 1000));
        await new Promise(r => setTimeout(r, wait));
      } else {
        throw err;
      }
    }
  }
  
  throw new Error(`Failed to acquire lock after ${maxWaitMs}ms: ${lockFile}`);
}

async function releaseLock(lockFile: string): Promise<void> {
  try {
    await fs.unlink(lockFile);
    api?.log.debug(`Lock released: ${lockFile}`);
  } catch (err: any) {
    if (err.code !== 'ENOENT') {
      api?.log.error(`Failed to release lock: ${lockFile}`, err);
    }
  }
}

/**
 * Forward event to TypeScript API
 */
// forwardToApi removed — all event forwarding now goes through the shared SQLite message bus

/**
 * Parse restore_remote tool arguments
 * Format: --session {id} --entry {id} [--keys key1,key2,...]
 */
function parseRestoreRemoteArgs(args: string[]): { session?: string; entry?: string; keys?: string[] } {
  const result: { session?: string; entry?: string; keys?: string[] } = {};
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--session' && i + 1 < args.length) {
      result.session = args[++i];
    } else if (arg === '--entry' && i + 1 < args.length) {
      result.entry = args[++i];
    } else if (arg === '--keys' && i + 1 < args.length) {
      result.keys = args[++i].split(',').map(k => k.trim()).filter(Boolean);
    }
  }
  
  return result;
}

/**
 * Restore extracted content for a session entry.
 * Uses custom file locking for the synchronous tool execution path.
 * TODO(kb-108): Migrate to bus-based restore (send restore.request, await
 * restore.response) once the API handler is proven stable. The API handler
 * in app.ts already supports restore.request with proper OpenClawLockAdapter.
 */
async function restoreRemoteContent(
  agentId: string,
  sessionId: string,
  entryId: string,
  keysToRestore?: string[]
): Promise<{ success: boolean; restoredKeys?: string[]; error?: string }> {
  if (!api) {
    return { success: false, error: 'Plugin not activated' };
  }
  
  api.log.debug(`restoreRemoteContent: agent=${agentId} session=${sessionId} entry=${entryId} keys=${keysToRestore?.join(',') || 'all'}`);
  
  try {
    // Find extracted file
    const agentsDir = api?.config?.agentsDir || '/home/openclaw/.openclaw/agents';
    const extractedPath = path.join(agentsDir, agentId, 'sessions', 'extracted', sessionId, `${entryId}.jsonl`);
    
    // Check if extracted file exists
    try {
      await fs.access(extractedPath);
    } catch {
      return { success: false, error: `No extracted content found for entry: ${entryId}` };
    }
    
    // Read extracted content
    const extractedContent = await fs.readFile(extractedPath, 'utf-8');
    const extractedData = JSON.parse(extractedContent);
    
    // Determine which keys to restore
    const keys = keysToRestore || Object.keys(extractedData).filter(k => !k.startsWith('__'));
    
    // Read current session
    const sessionFile = path.join(agentsDir, agentId, 'sessions', `${sessionId}.jsonl`);
    const lockFile = `${sessionFile}.lock`;
    
    api.log.debug(`acquiring lock: ${lockFile}`);
    await acquireLock(lockFile);
    api.log.debug('lock acquired');
    
    try {
      const sessionContent = await fs.readFile(sessionFile, 'utf-8');
      const lines = sessionContent.split('\n').filter(l => l.trim());
      const entries = lines.map(line => JSON.parse(line));
      
      // Find the entry to restore
      let entryIndex = -1;
      let targetEntry: any = null;
      
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (entry.__id === entryId || entry.id === entryId) {
          entryIndex = i;
          targetEntry = entry;
          break;
        }
      }
      
      if (entryIndex === -1 || !targetEntry) {
        return { success: false, error: `Entry ${entryId} not found in session` };
      }
      
      // Restore the specified keys
      const restoredKeys: string[] = [];
      const entryId = targetEntry.__id || targetEntry.id || 'unknown';
      const expectedPlaceholder = `[[extracted-${entryId}]]`;
      
      function restoreInObject(obj: any, pathPrefix: string[] = []): void {
        for (const key of Object.keys(obj)) {
          const fullPath = [...pathPrefix, key];
          const fullKey = fullPath.join('.');
          
          const value = obj[key];
          // Check for both old [[extracted]] and new [[extracted-${entryId}]] formats
          if (value === '[[extracted]]' || value === expectedPlaceholder ||
              (typeof value === 'string' && value.startsWith('[[extracted-'))) {
            const extractedValue = getNestedValue(extractedData, fullPath);
            if (extractedValue !== undefined) {
              obj[key] = extractedValue;
              restoredKeys.push(fullKey);
            }
          } else if (typeof value === 'object' && value !== null) {
            restoreInObject(value, fullPath);
          }
        }
      }
      
      function getNestedValue(data: any, keyPath: string[]): any {
        let current = data;
        for (const key of keyPath) {
          if (current === null || typeof current !== 'object') return undefined;
          current = current[key];
        }
        return current;
      }
      
      // Perform restoration
      restoreInObject(targetEntry);
      
      // Check if this is a re-restore (entry already has _restored timestamp)
      const isReRestore = !!targetEntry._restored;
      const previousRestoredAt = targetEntry._restored;
      
      // Mark entry as restored with _restored timestamp (used for time-based re-extraction protection)
      targetEntry._restored = new Date().toISOString();
      targetEntry.__restored_keys = restoredKeys;
      
      // Write updated session
      const updatedContent = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
      await fs.writeFile(sessionFile, updatedContent, 'utf-8');
      
      api.log.info(`Restored ${restoredKeys.length} keys for entry ${entryId} in session ${sessionId}${isReRestore ? ' (re-restore)' : ''}`);
      
      // Notify via message bus
      bus.publish('entry_restored', {
        agentId,
        sessionId,
        entryId,
        keysRestored: restoredKeys,
        timestamp: new Date().toISOString(),
        isReRestore,
        previousRestoredAt,
      });
      
      const result: any = { success: true, restoredKeys };
      if (isReRestore && previousRestoredAt) {
        result.previousRestoredAt = previousRestoredAt;
        result.suggestion = 'This entry was previously restored. If you need to keep this content long-term, consider setting _extractable: false.';
      }
      return result;
    } finally {
      await releaseLock(lockFile);
      api.log.debug('lock released');
    }
  } catch (error: any) {
    api.log.error(`restore_remote error: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Plugin activation - called by OpenClaw when plugin loads
 */
export async function activate(pluginApi: PluginApi): Promise<void> {
  api = pluginApi;
  
  api.log.info('BrainSurgeon plugin activating...');
  api.log.debug(`config: ${JSON.stringify(api.config)}`);

  // Register restore_remote tool
  api.registerTool({
    name: 'restore_remote',
    description: 'Restore extracted content from external storage into the session. Usage: restore_remote --session {id} --entry {id} [--keys key1,key2,...]',
    parameters: Type.Object({
      session: Type.String({ description: 'Session ID containing the extracted entry' }),
      entry: Type.String({ description: 'Entry ID (the __id field) of the entry with extracted content' }),
      keys: Type.Optional(Type.String({ description: 'Comma-separated list of specific keys to restore (default: all extracted keys)' })),
    }),
    async execute(_id: string, params: { session: string; entry: string; keys?: string }) {
      if (!api) {
        throw new Error('Plugin not activated');
      }
      
      api.log.debug(`restore_remote called: session=${params.session} entry=${params.entry} keys=${params.keys || 'all'}`);
      
      // Parse keys if provided
      const keysToRestore = params.keys ? params.keys.split(',').map(k => k.trim()).filter(Boolean) : undefined;
      
      // Determine agent from session context (this would come from OpenClaw context)
      // For now, we need to search across agents to find the session
      const agentsDir = api?.config?.agentsDir || '/home/openclaw/.openclaw/agents';
      const agents = await fs.readdir(agentsDir).catch(() => []);
      
      let result: { success: boolean; restoredKeys?: string[]; error?: string } | null = null;
      let foundAgent: string | null = null;
      
      for (const agent of agents) {
        const sessionFile = path.join(agentsDir, agent, 'sessions', `${params.session}.jsonl`);
        try {
          await fs.access(sessionFile);
          foundAgent = agent;
          api.log.debug(`found session ${params.session} in agent ${agent}`);
          result = await restoreRemoteContent(agent, params.session, params.entry, keysToRestore);
          break;
        } catch {
          // Session not in this agent, continue
        }
      }
      
      if (!foundAgent) {
        throw new Error(`Session ${params.session} not found in any agent`);
      }
      
      if (!result || !result.success) {
        throw new Error(result?.error || 'Restore failed');
      }
      
      // Return result to agent
      // Note: By default, OpenClaw will consume this tool call (remove from session)
      // unless keepRestoreRemoteCalls config is true
      return {
        content: [
          {
            type: 'text',
            text: `Successfully restored ${result.restoredKeys?.length || 0} keys for entry ${params.entry}\nKeys: ${result.restoredKeys?.join(', ') || 'none'}`,
          },
        ],
        // Signal to OpenClaw whether to keep or consume this tool call
        _consumeToolCall: !api.config?.keepRestoreRemoteCalls,
      };
    },
  });

  // Subscribe to message_written events for smart pruning
  api.on('message_written', async (event: any) => {
    api?.log.debug(`message_written event: ${JSON.stringify(event)}`);
    
    // Publish to message bus (API subscribes)
    bus.publish('message_written', event);
    
    // Auto-trigger smart pruning if enabled
    if (api?.config?.enableAutoPrune !== false) {
      const threshold = api?.config?.autoPruneThreshold || 3;
      
      // Request prune via message bus
      bus.publish('prune.request', {
        agentId: event.agentId,
        sessionId: event.sessionId,
        threshold,
      });
      api?.log.debug(`auto-prune request published for ${event.sessionId}`);
    }
  });

  // Subscribe to session_created events
  api.on('session_created', async (event: any) => {
    api?.log.debug(`session_created event: ${JSON.stringify(event)}`);
    bus.publish('session.created', event);
  });

  // Register compact command for OpenClaw integration
  api.registerCommand({
    name: 'bscompact',
    description: 'Trigger BrainSurgeon compact for current session',
    aliases: ['bsc'],
    async handler(ctx: CommandContext) {
      const { agentId, sessionId, prompt } = ctx;
      
      if (!agentId || !sessionId) {
        return { success: false, error: 'No active session' };
      }
      
      api?.log.info(`Compact command triggered for ${agentId}/${sessionId}`);
      
      try {
        // Emit before_compaction event to trigger OpenClaw's compaction
        api?.emit('before_compaction', {
          agentId,
          sessionId,
          customInstructions: prompt,
          triggeredBy: 'brainsurgeon',
        });
        
        // Notify via message bus
        bus.publish('session.compacted', {
          agentId,
          sessionId,
          instructions: prompt,
          timestamp: new Date().toISOString(),
        });
        
        return {
          success: true,
          message: `Compaction triggered for session ${sessionId}`,
        };
      } catch (err: any) {
        api?.log.error(`compact command failed: ${err.message}`);
        return {
          success: false,
          error: `Compaction failed: ${err.message}`,
        };
      }
    },
  });

  // Subscribe to compact.request from message bus (sent by API when web UI triggers compact)
  bus.subscribe('compact.request', (msg) => {
    const { agentId, sessionId, instructions } = msg.payload as any;
    api?.log.info(`compact.request received via bus for ${agentId}/${sessionId}`);
    
    // Emit before_compaction event to trigger OpenClaw's compaction
    api?.emit('before_compaction', {
      agentId,
      sessionId,
      customInstructions: instructions,
      triggeredBy: 'brainsurgeon-api',
    });
    
    // Acknowledge via bus
    bus.publish('compact.response', {
      agentId,
      sessionId,
      success: true,
    });
  });

  // Subscribe to prune.response from API (result of prune.request)
  bus.subscribe('prune.response', (msg) => {
    const payload = msg.payload as any;
    if (payload.success && payload.externalized > 0) {
      api?.log.info(`prune completed: ${payload.externalized} entries externalized for ${payload.sessionId}`);
    }
  });

  // Start the message bus polling
  const busDbPath = api.config?.busDbPath || '/home/openclaw/.openclaw/brainsurgeon/bus.db';
  try {
    // Ensure bus directory exists
    const busDir = path.dirname(busDbPath);
    await fs.mkdir(busDir, { recursive: true });
    bus.open(busDbPath);
    bus.start();
    api.log.info(`message bus connected: ${busDbPath}`);
  } catch (err: any) {
    api.log.error(`failed to open message bus: ${err.message}`);
  }

  api.log.info('BrainSurgeon plugin activated successfully');
}

/**
 * Plugin deactivation - called by OpenClaw when plugin unloads
 */
export async function deactivate(): Promise<void> {
  api?.log.info('BrainSurgeon plugin deactivating...');
  
  // Stop message bus
  bus.stop();
  
  api = null;
}

// Legacy default export for compatibility
export default { activate, deactivate };
