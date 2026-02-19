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
    api?.log.error(`Error forwarding event to ${endpoint}:`, err);
  }
}

/**
 * Plugin activation - called by OpenClaw when plugin loads
 */
export async function activate(pluginApi: PluginApi): Promise<void> {
  api = pluginApi;
  
  api.log.info('BrainSurgeon plugin activating...');
  api.log.info(`Config: ${JSON.stringify(api.config)}`);

  // Register restore_response tool
  api.registerTool({
    name: 'restore_response',
    description: 'Rehydrate pruned tool response content from external storage back into the session',
    parameters: Type.Object({
      toolcallid: Type.String({ description: 'ID of the tool call whose response should be restored' }),
    }),
    async execute(_id: string, params: { toolcallid: string }) {
      const { toolcallid } = params;
      
      if (!api) {
        throw new Error('Plugin not activated');
      }
      
      try {
        // Find the external file
        // External storage path: ~/.openclaw/agents/{agent}/sessions/external/{toolcallid}.json
        const agentsDir = '/home/openclaw/.openclaw/agents';
        const externalFiles: string[] = [];
        
        // Search all agent directories for the external file
        const agents = await fs.readdir(agentsDir).catch(() => []);
        for (const agent of agents) {
          const externalPath = path.join(agentsDir, agent, 'sessions', 'external', `${toolcallid}.json`);
          try {
            await fs.access(externalPath);
            externalFiles.push(externalPath);
          } catch {
            // File doesn't exist - continue searching
          }
        }
        
        if (externalFiles.length === 0) {
          throw new Error(`No external content found for tool call: ${toolcallid}`);
        }
        
        // Use first match (should be unique)
        const externalPath = externalFiles[0];
        const externalContent = await fs.readFile(externalPath, 'utf-8');
        const externalEntry = JSON.parse(externalContent);
        
        // Extract agent and session from the path
        const pathParts = externalPath.split('/');
        const agentIdx = pathParts.indexOf('agents');
        const agentId = pathParts[agentIdx + 1];
        const sessionId = pathParts[agentIdx + 3]; // sessions/{sessionId}/external/...
        
        const sessionFile = path.join(agentsDir, agentId, 'sessions', `${sessionId}.jsonl`);
        const lockFile = `${sessionFile}.lock`;
        
        // Acquire lock
        await acquireLock(lockFile);
        
        try {
          // Read current session
          const sessionContent = await fs.readFile(sessionFile, 'utf-8');
          const lines = sessionContent.split('\n').filter(l => l.trim());
          const entries = lines.map(line => JSON.parse(line));
          
          // Find and replace the pruned stub with the full entry
          let found = false;
          const updatedEntries = entries.map(entry => {
            // Check if this is a restore_response entry or a pruned stub for this toolcall
            const isTarget = 
              (entry.type === 'restore_response' && entry.parameters?.toolcallid === toolcallid) ||
              (entry.tool_call_id === toolcallid) ||
              (entry.message?.tool_call_id === toolcallid) ||
              (entry._external_id === toolcallid);
            
            if (isTarget && !found) {
              found = true;
              api.log.info(`Restoring tool response for ${toolcallid} in session ${sessionId}`);
              // Return the full external entry instead of the stub
              return {
                ...externalEntry,
                _restored_at: new Date().toISOString(),
                _restored_from: externalPath,
              };
            }
            return entry;
          });
          
          if (!found) {
            api.log.warn(`No matching entry found for ${toolcallid} - appending as new entry`);
            updatedEntries.push({
              ...externalEntry,
              _restored_at: new Date().toISOString(),
              _restored_from: externalPath,
              _appended: true,
            });
          }
          
          // Write updated session
          const updatedContent = updatedEntries.map(e => JSON.stringify(e)).join('\n') + '\n';
          await fs.writeFile(sessionFile, updatedContent, 'utf-8');
          
          // Delete external file after successful restore
          await fs.unlink(externalPath);
          api.log.info(`External file removed: ${externalPath}`);
          
          // Notify TypeScript API of the change
          await forwardToApi('/api/events/entry-restored', {
            agentId,
            sessionId,
            toolcallid,
            timestamp: new Date().toISOString(),
          });
          
          return {
            content: [
              {
                type: 'text',
                text: `Tool response restored successfully for tool call: ${toolcallid}\nSession: ${sessionId}\nAgent: ${agentId}`,
              },
            ],
          };
        } finally {
          await releaseLock(lockFile);
        }
      } catch (error: any) {
        api.log.error('restore_response tool error:', error);
        throw new Error(`Failed to restore response: ${error.message}`);
      }
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
      // This would typically call the TypeScript API to evaluate and trigger pruning
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
        api?.log.error('Auto-prune failed:', err);
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
        api?.log.error('Compact command failed:', err);
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
        api?.log.error('HTTP compact trigger failed:', err);
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
  
  console.log('BrainSurgeon extension deactivated');
}

// Legacy default export for compatibility
export default { activate, deactivate };
