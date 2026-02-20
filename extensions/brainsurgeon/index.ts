import { Type } from '@sinclair/typebox';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// Full OpenClaw Plugin API interface (provided by OpenClaw at runtime)
interface PluginApi {
  id: string;
  name: string;
  version?: string;
  description?: string;
  config: {
    apiUrl?: string;
    enableAutoPrune?: boolean;
    autoPruneThreshold?: number;
    keepRestoreRemoteCalls?: boolean; // Debug toggle
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
async function forwardToApi(endpoint: string, data: any): Promise<void> {
  const apiUrl = api?.config?.apiUrl || 'http://localhost:8000';
  const url = `${apiUrl}${endpoint}`;
  
  try {
    // Use fetch if available, otherwise skip
    if (typeof fetch === 'undefined') {
      api?.log.debug(`Skipping event forward (no fetch): ${url}`);
      return;
    }
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    
    if (!response.ok) {
      api?.log.error(`Failed to forward event to ${endpoint}: ${response.status}`);
    } else {
      api?.log.debug(`Event forwarded to ${endpoint}`);
    }
  } catch (err: any) {
    api?.log.error(`error forwarding event to ${endpoint}: ${err.message}`);
  }
}

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
 * Restore extracted content for a session entry
 * Returns the restored entry data and whether the tool call should be consumed
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
      
      function restoreInObject(obj: any, pathPrefix: string[] = []): void {
        for (const key of Object.keys(obj)) {
          const fullPath = [...pathPrefix, key];
          const fullKey = fullPath.join('.');
          
          if (obj[key] === '[[extracted]]') {
            const extractedValue = getNestedValue(extractedData, fullPath);
            if (extractedValue !== undefined) {
              obj[key] = extractedValue;
              restoredKeys.push(fullKey);
            }
          } else if (typeof obj[key] === 'object' && obj[key] !== null) {
            restoreInObject(obj[key], fullPath);
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
      
      // Mark entry as restored
      targetEntry.__restored_at = new Date().toISOString();
      targetEntry.__restored_keys = restoredKeys;
      
      // Write updated session
      const updatedContent = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
      await fs.writeFile(sessionFile, updatedContent, 'utf-8');
      
      api.log.info(`Restored ${restoredKeys.length} keys for entry ${entryId} in session ${sessionId}`);
      
      // Notify TypeScript API
      await forwardToApi('/api/events/content-restored', {
        agentId,
        sessionId,
        entryId,
        keysRestored: restoredKeys,
        timestamp: new Date().toISOString(),
      });
      
      return { success: true, restoredKeys };
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
    
    // Forward to TypeScript API
    await forwardToApi('/api/events/message-written', event);
    
    // Auto-trigger smart pruning if enabled
    if (api?.config?.enableAutoPrune !== false) {
      const threshold = api?.config?.autoPruneThreshold || 3;
      
      // Check if pruning conditions met
      try {
        const apiUrl = api?.config?.apiUrl || 'http://localhost:8000';
        const response = await fetch(`${apiUrl}/api/sessions/${event.agentId}/${event.sessionId}/prune/smart`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ threshold }),
        });
        
        if (response.ok) {
          const result = await response.json();
          if (result.pruned > 0) {
            api?.log.info(`Auto-pruned ${result.pruned} entries for ${event.sessionId}`);
          }
        }
      } catch (err: any) {
        api?.log.error(`auto-prune failed: ${err.message}`);
      }
    }
  });

  // Subscribe to session_created events
  api.on('session_created', async (event: any) => {
    api?.log.debug(`session_created event: ${JSON.stringify(event)}`);
    await forwardToApi('/api/events/session-created', event);
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
        
        // Notify TypeScript API
        await forwardToApi('/api/events/compaction-triggered', {
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

  // Register HTTP route for external compact trigger (from TypeScript API)
  api.registerHttpRoute({
    path: '/trigger-compact',
    async handler(req: any, res: any) {
      try {
        const body = await req.json?.() || {};
        const { agentId, sessionId, instructions } = body;
        
        if (!agentId || !sessionId) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'Missing agentId or sessionId' }));
          return;
        }
        
        api?.log.info(`HTTP compact trigger for ${agentId}/${sessionId}`);
        
        // Emit compaction event
        api?.emit('before_compaction', {
          agentId,
          sessionId,
          customInstructions: instructions,
          triggeredBy: 'brainsurgeon-api',
        });
        
        res.statusCode = 200;
        res.end(JSON.stringify({
          success: true,
          message: 'Compaction triggered',
          agentId,
          sessionId,
        }));
      } catch (err: any) {
        api?.log.error(`HTTP compact trigger failed: ${err.message}`);
        res.statusCode = 500;
        res.end(JSON.stringify({ error: err.message }));
      }
    },
  });

  api.log.info('BrainSurgeon plugin activated successfully');
}

/**
 * Plugin deactivation - called by OpenClaw when plugin unloads
 */
export async function deactivate(): Promise<void> {
  api?.log.info('BrainSurgeon plugin deactivating...');
  
  // Cleanup any resources
  api = null;
  
  // api is already null at this point, so we can't log via api.log
}

// Legacy default export for compatibility
export default { activate, deactivate };
