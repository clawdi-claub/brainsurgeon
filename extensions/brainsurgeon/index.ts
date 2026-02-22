import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * BrainSurgeon OpenClaw Plugin
 *
 * Provides:
 * - purge_control tool for controlling extraction (get_context, restore, set_extractable)
 * - Server-side pruning via BrainSurgeon API integration
 *
 * DESIGN NOTE: Cross-Agent Operations
 * ------------------------------------
 * The purge_control tool uses ctx.agentId (the current agent's ID) for all operations.
 * This means each agent can only manage its own sessions via the tool.
 *
 * For cross-agent maintenance (e.g., a "maintenance" agent cleaning up other agents' sessions),
 * use the BrainSurgeon API directly:
 *   GET  /api/sessions/:agent/:id/context
 *   PUT  /api/sessions/:agent/:id/entries/:entryId/meta
 *   POST /api/sessions/:agent/:id/entries/:entryId/restore
 *
 * This design ensures:
 * 1. Clear session ownership (agents manage their own data)
 * 2. No permission complexity in the tool layer
 * 3. Admin/maintenance capabilities available via API for authorized use cases
 */

// Minimal types - real types come from OpenClaw at runtime
type PluginApi = {
  id: string;
  name: string;
  config: Record<string, any>;
  pluginConfig?: Record<string, any>;
  runtime: any;
  logger: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
    debug?: (msg: string) => void;
  };
  registerTool: (tool: any, opts?: any) => void;
  registerCommand: (cmd: any) => void;
  on: (hookName: string, handler: (...args: any[]) => any, opts?: any) => void;
  resolvePath: (input: string) => string;
};

// Fallback logger in case api.logger is undefined
const fallbackLogger = {
  info: (msg: string) => console.log(`[INFO] ${msg}`),
  warn: (msg: string) => console.warn(`[WARN] ${msg}`),
  error: (msg: string) => console.error(`[ERROR] ${msg}`),
  debug: (msg: string) => undefined,
};

// Plugin config (from openclaw.json plugins.entries.brainsurgeon.config)
function getPluginConfig(api: PluginApi) {
  const pc = api.pluginConfig || {};
  return {
    agentsDir: (pc.agentsDir as string) || '/home/openclaw/.openclaw/agents',
    apiUrl: (pc.apiUrl as string) || 'http://localhost:8000',
    apiKey: (pc.apiKey as string) || 'dev_key_insecure_do_not_use_in_prod',
    enableAutoPrune: pc.enableAutoPrune !== false,
    autoPruneThreshold: (pc.autoPruneThreshold as number) || 3,
    keepRestoreRemoteCalls: !!pc.keepRestoreRemoteCalls,
    busDbPath: (pc.busDbPath as string) || '/home/openclaw/.openclaw/brainsurgeon/bus.db',
  };
}

// ─── File locking ──────────────────────────────────────────────────────

async function acquireLock(lockFile: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await fs.writeFile(lockFile, `${process.pid}\n${new Date().toISOString()}`, { flag: 'wx' });
      return;
    } catch {
      await new Promise(r => setTimeout(r, 50));
    }
  }
  // Force-break stale lock
  try { await fs.unlink(lockFile); } catch {}
  await fs.writeFile(lockFile, `${process.pid}\n${new Date().toISOString()}`, { flag: 'wx' });
}

async function releaseLock(lockFile: string): Promise<void> {
  try { await fs.unlink(lockFile); } catch {}
}

// ─── Restore logic ────────────────────────────────────────────────────

async function restoreEntry(
  agentsDir: string,
  agentId: string,
  sessionId: string,
  entryId: string,
  keysToRestore?: string[],
  logger?: PluginApi['logger'],
): Promise<{ success: boolean; restoredKeys?: string[]; error?: string; suggestion?: string; previousRestoredAt?: string }> {
  // Find session file
  const sessionsDir = path.join(agentsDir, agentId, 'sessions');
  const files = await fs.readdir(sessionsDir);
  const sessionFile = files.find(f => f.startsWith(sessionId) && f.endsWith('.jsonl'));
  if (!sessionFile) {
    return { success: false, error: `Session ${sessionId} not found` };
  }

  const sessionPath = path.join(sessionsDir, sessionFile);
  const lockFile = sessionPath + '.lock';

  try {
    await acquireLock(lockFile);
    try {
      const content = await fs.readFile(sessionPath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      const entries = lines.map(line => JSON.parse(line));

      // Find target entry
      let entryIndex = -1;
      let targetEntry: any = null;
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        if (e.__id === entryId || e.id === entryId) {
          entryIndex = i;
          targetEntry = e;
          break;
        }
      }

      if (entryIndex === -1 || !targetEntry) {
        return { success: false, error: `Entry ${entryId} not found in session` };
      }

      // Load extracted data
      const extractedPath = path.join(sessionsDir, 'extracted', sessionId, `${entryId}.json`);
      let extractedData: any;
      try {
        await fs.access(extractedPath);
        const raw = await fs.readFile(extractedPath, 'utf-8');
        extractedData = JSON.parse(raw);
      } catch {
        return { success: false, error: `No extracted content found for entry: ${entryId}` };
      }

      const eid = targetEntry.__id || targetEntry.id || 'unknown';
      const expectedPlaceholder = `[[extracted-${eid}]]`;
      const restoredKeys: string[] = [];

      // Restore placeholders
      function restoreInObject(obj: any, pathPrefix: string[] = []): void {
        for (const key of Object.keys(obj)) {
          const fullPath = [...pathPrefix, key];
          const fullKey = fullPath.join('.');
          const value = obj[key];

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

      restoreInObject(targetEntry);

      // Re-restore detection
      const isReRestore = !!targetEntry._restored;
      const previousRestoredAt = targetEntry._restored;

      // Mark as restored
      targetEntry._restored = new Date().toISOString();
      targetEntry.__restored_keys = restoredKeys;

      // Write back
      const updatedContent = entries.map((e: any) => JSON.stringify(e)).join('\n') + '\n';
      await fs.writeFile(sessionPath, updatedContent, 'utf-8');

      logger?.info?.(`Restored ${restoredKeys.length} keys for entry ${entryId} in session ${sessionId}${isReRestore ? ' (re-restore)' : ''}`);

      const result: any = { success: true, restoredKeys };
      if (isReRestore && previousRestoredAt) {
        result.previousRestoredAt = previousRestoredAt;
        result.suggestion = 'This entry was previously restored. Consider setting _extractable: false to keep it long-term.';
      }
      return result;

    } finally {
      await releaseLock(lockFile);
    }
  } catch (err: any) {
    logger?.error?.(`purge_control restore error: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// ─── API helper ───────────────────────────────────────────────────────

async function callBrainSurgeonApi(apiUrl: string, apiKey: string, method: string, path: string, body?: any): Promise<any> {
  const url = `${apiUrl}${path}`;
  const headers: Record<string, string> = {
    'X-API-Key': apiKey,
  };
  if (body) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`BrainSurgeon API ${method} ${path}: ${res.status} ${text}`);
  }
  return res.json();
}

// ─── Plugin definition ────────────────────────────────────────────────

const plugin = {
  id: 'brainsurgeon',
  name: 'BrainSurgeon',
  description: 'Session management plugin — purge_control tool (get_context, restore, set_extractable)',
  version: '2.0.0',

  register(api: PluginApi) {
    const cfg = getPluginConfig(api);
    const log = api.logger || fallbackLogger;

    log.info('BrainSurgeon plugin registering...');
    log.debug?.(`BrainSurgeon config: agentsDir=${cfg.agentsDir}, apiUrl=${cfg.apiUrl}, autoPrune=${cfg.enableAutoPrune}`);

    // ── purge_control tool ────────────────────────────────────────────
    // Unified tool for controlling BrainSurgeon extraction
    // Actions: get_context, restore, set_extractable
    api.registerTool(
      (ctx: any) => {
        if (!ctx?.agentId) return null;
        return {
          name: 'purge_control',
          description: 'Control BrainSurgeon extraction: get_context (view session stats), restore (restore extracted content), set_extractable (mark entries for extraction control).',
          parameters: {
            type: 'object',
            required: ['action'],
            properties: {
              action: {
                type: 'string',
                enum: ['get_context', 'restore', 'set_extractable'],
                description: 'Action to perform: get_context (view stats), restore (restore content), set_extractable (control extraction)',
              },
              session: {
                type: 'string',
                description: 'Session ID (required for all actions)',
              },
              entry: {
                type: 'string',
                description: 'Entry ID (required for restore and set_extractable actions)',
              },
              keys: {
                type: 'string',
                description: 'Comma-separated list of keys to restore (optional, for restore action)',
              },
              value: {
                type: 'string',
                description: 'Value for set_extractable: "true", "false", or integer (e.g., "10")',
              },
            },
          },
          async execute(_toolCallId: string, params: {
            action: string;
            session?: string;
            entry?: string;
            keys?: string;
            value?: string;
          }) {
            const agentId = ctx.agentId!;

            if (!params.session) {
              return {
                content: [{ type: 'text', text: 'Error: session parameter is required' }],
              };
            }

            // ── Action: get_context ─────────────────────────────────────
            if (params.action === 'get_context') {
              try {
                const result = await callBrainSurgeonApi(
                  cfg.apiUrl,
                  cfg.apiKey,
                  'GET',
                  `/api/sessions/${agentId}/${params.session}`
                );

                const entries = result.entries || [];
                const extracted = entries.filter((e: any) =>
                  Object.values(e).some(v =>
                    typeof v === 'string' && v.startsWith('[[extracted-')
                  )
                );

                const text = `Session: ${params.session}\n` +
                  `Total entries: ${entries.length}\n` +
                  `Extracted entries: ${extracted.length}\n\n` +
                  `Extracted entry IDs:\n` +
                  (extracted.length > 0
                    ? extracted.map((e: any) => `  - ${e.__id || e.id || 'unknown'}`).join('\n')
                    : '  (none)');

                return { content: [{ type: 'text', text }] };
              } catch (err: any) {
                return { content: [{ type: 'text', text: `Error getting context: ${err.message}` }] };
              }
            }

            // ── Action: restore ─────────────────────────────────────────
            if (params.action === 'restore') {
              if (!params.entry) {
                return {
                  content: [{ type: 'text', text: 'Error: entry parameter is required for restore action' }],
                };
              }

              const keysArr = params.keys?.split(',').map(k => k.trim()) || undefined;

              const result = await restoreEntry(
                cfg.agentsDir,
                agentId,
                params.session,
                params.entry,
                keysArr,
                log,
              );

              if (!result.success) {
                return {
                  content: [{ type: 'text', text: `Restore failed: ${result.error}${result.suggestion ? `\n\nSuggestion: ${result.suggestion}` : ''}` }],
                };
              }

              let text = `Restored ${result.restoredKeys?.length || 0} keys for entry ${params.entry}\nKeys: ${result.restoredKeys?.join(', ') || 'none'}`;
              if (result.suggestion) {
                text += `\n\nNote: ${result.suggestion}`;
              }

              return {
                content: [{ type: 'text', text }],
                _consumeToolCall: !cfg.keepRestoreRemoteCalls,
              };
            }

            // ── Action: set_extractable ───────────────────────────────────
            if (params.action === 'set_extractable') {
              if (!params.entry) {
                return {
                  content: [{ type: 'text', text: 'Error: entry parameter is required for set_extractable action' }],
                };
              }
              if (!params.value) {
                return {
                  content: [{ type: 'text', text: 'Error: value parameter is required for set_extractable action (true, false, or integer)' }],
                };
              }

              // Parse value
              let extractableValue: boolean | number;
              const val = params.value.toLowerCase();
              if (val === 'true') {
                extractableValue = true;
              } else if (val === 'false') {
                extractableValue = false;
              } else {
                const num = parseInt(params.value, 10);
                if (isNaN(num)) {
                  return {
                    content: [{ type: 'text', text: `Error: value must be 'true', 'false', or integer, got: ${params.value}` }],
                  };
                }
                extractableValue = num;
              }

              // Call API to update entry metadata
              try {
                await callBrainSurgeonApi(
                  cfg.apiUrl,
                  cfg.apiKey,
                  'PUT',
                  `/api/sessions/${agentId}/${params.session}/entries/${params.entry}/meta`,
                  { _extractable: extractableValue }
                );

                return {
                  content: [{ type: 'text', text: `Set _extractable=${extractableValue} for entry ${params.entry}` }],
                };
              } catch (err: any) {
                return {
                  content: [{ type: 'text', text: `Error setting _extractable: ${err.message}` }],
                };
              }
            }

            // ── Unknown action ────────────────────────────────────────────
            return {
              content: [{ type: 'text', text: `Error: Unknown action '${params.action}'. Valid actions: get_context, restore, set_extractable` }],
            };
          },
        };
      },
      { name: 'purge_control' },
    );

    // ── after_tool_call hook: auto-prune trigger ──────────────────────
    // Note: auto-prune is disabled in dev/experimental mode
    // The extension provides purge_control tool; pruning is handled server-side
    // or via explicit API calls from the BrainSurgeon cron service
    if (cfg.enableAutoPrune) {
      log.info(`Auto-prune registered (threshold: ${cfg.autoPruneThreshold}) - server-side pruning enabled`);
      // Server-side pruning happens via BrainSurgeon API cron jobs
      // Extension does not need to trigger pruning on every tool call
    }

    log.info('BrainSurgeon plugin registered successfully');
  },
};

export default plugin;
