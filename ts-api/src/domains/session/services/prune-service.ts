import { join } from 'node:path';
import type { Session, JsonEntry } from '../models/entry.js';
import type { SessionRepository } from '../repository/session-repository.js';
import type { LockService } from '../../lock/services/lock-service.js';
import type { ExternalStorage } from '../../../infrastructure/external/storage.js';

export interface PruneOptions {
  /** Keep last N tool results. 0 = remove all. -1 = light prune (summarize). Default: 3 */
  keepRecent?: number;
  /** Externalize tool results after this many messages. Default: 3 */
  threshold?: number;
}

export interface PruneResult {
  pruned_count: number;
  original_size: number;
  new_size: number;
  externalized?: number;
}

export class PruneService {
  constructor(
    private sessionRepo: SessionRepository,
    private lockService: LockService,
    private externalStorage: ExternalStorage,
    private agentsDir: string = '/home/openclaw/.openclaw/agents'
  ) {}

  async execute(
    agentId: string,
    sessionId: string,
    options: PruneOptions = {}
  ): Promise<PruneResult> {
    const { keepRecent = 3, threshold = 3 } = options;

    const sessionFile = join(this.agentsDir, agentId, 'sessions', `${sessionId}.jsonl`);
    const lock = await this.lockService.acquire(sessionFile);

    try {
      const session = await this.sessionRepo.load(agentId, sessionId);
      const entries = session.entries;
      const originalSize = JSON.stringify(entries).length;

      let prunedCount = 0;

      if (keepRecent === -1) {
        // Light prune: truncate very long assistant content
        const result = this.lightPrune(entries);
        prunedCount = result.prunedCount;

        if (prunedCount > 0) {
          await this.sessionRepo.save(agentId, sessionId, { ...session, entries: result.entries });
        }
      } else {
        // Full prune: remove tool result content
        const result = this.fullPrune(entries, keepRecent);
        prunedCount = result.prunedCount;

        if (prunedCount > 0) {
          // Also externalize removed entries for restore_response tool
          for (const entry of result.externalized) {
            const entryId = entry.id as string;
            if (entryId) {
              await this.externalStorage.store(agentId, sessionId, entryId, entry);
            }
          }

          await this.sessionRepo.save(agentId, sessionId, { ...session, entries: result.entries });
        }
      }

      const newSize = JSON.stringify(session.entries).length;

      return {
        pruned_count: prunedCount,
        original_size: originalSize,
        new_size: newSize,
      };
    } finally {
      await lock.release();
    }
  }

  /**
   * Light prune: truncate very long assistant responses.
   * Matches Python API light prune (keep_recent = -1).
   */
  private lightPrune(
    entries: JsonEntry[]
  ): { entries: JsonEntry[]; prunedCount: number } {
    const LONG_TEXT_THRESHOLD = 5000;
    let prunedCount = 0;

    const result = entries.map(entry => {
      if ((entry.type as string) !== 'message') return entry;

      const msg = entry.message as Record<string, unknown> | undefined;
      if (!msg || (msg.role as string) !== 'assistant') return entry;

      const content = msg.content;
      if (typeof content !== 'string' || content.length <= LONG_TEXT_THRESHOLD) return entry;

      const summary = content.slice(0, 500) +
        `\n\n[... ${content.length - LONG_TEXT_THRESHOLD} chars pruned ...]`;

      prunedCount++;
      return {
        ...entry,
        message: { ...msg, content: summary },
        _pruned: true,
        _pruned_type: 'light',
      };
    });

    return { entries: result, prunedCount };
  }

  /**
   * Full prune: remove old tool result content.
   * Matches Python API full prune (keep_recent >= 0).
   */
  private fullPrune(
    entries: JsonEntry[],
    keepRecent: number
  ): { entries: JsonEntry[]; prunedCount: number; externalized: JsonEntry[] } {
    // Find all tool-result-like entry indices
    const toolResultIndices = this.findToolResultIndices(entries);

    // Calculate which to prune (keep the last N)
    const pruneIndices = keepRecent > 0
      ? new Set(toolResultIndices.slice(0, -keepRecent))
      : new Set(toolResultIndices);

    const externalized: JsonEntry[] = [];
    let prunedCount = 0;

    const result = entries.map((entry, i) => {
      if (!pruneIndices.has(i)) return entry;

      externalized.push(entry);
      prunedCount++;
      return this.createPrunedStub(entry);
    });

    return { entries: result, prunedCount, externalized };
  }

  /** Find indices of tool result entries (matching OpenClaw format) */
  private findToolResultIndices(entries: JsonEntry[]): number[] {
    const indices: number[] = [];

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const type = entry.type as string;

      if (type === 'tool_result' || type === 'tool') {
        indices.push(i);
        continue;
      }

      if (type === 'message') {
        const msg = entry.message as Record<string, unknown> | undefined;
        if (!msg) continue;

        const role = msg.role as string;
        if (role === 'toolResult' || role === 'tool') {
          indices.push(i);
        }
      }
    }

    return indices;
  }

  private createPrunedStub(entry: JsonEntry): JsonEntry {
    const type = entry.type as string;

    if (type === 'message') {
      const msg = (entry.message as Record<string, unknown>) || {};
      return {
        ...entry,
        message: { ...msg, content: '[pruned]' },
        _pruned: true,
        _pruned_type: 'full',
      };
    }

    return {
      ...entry,
      content: '[pruned]',
      _pruned: true,
      _pruned_type: 'full',
    };
  }

  /**
   * Smart Live Prune: Check if pruning should trigger after new message.
   * Called by message bus when message_written event received.
   * Threshold: externalize tool results after N messages (default 3).
   */
  async smartLivePrune(
    agentId: string,
    sessionId: string,
    threshold: number = 3
  ): Promise<{ pruned: number; externalized: string[] } | null> {
    const session = await this.sessionRepo.load(agentId, sessionId);
    const entries = session.entries;

    // Find tool results that have threshold messages after them
    const toPrune: string[] = [];

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const entryType = entry.type as string;

      // Check if this is a tool result
      let isToolResult = false;
      if (entryType === 'tool_result' || entryType === 'tool') {
        isToolResult = true;
      } else if (entryType === 'message') {
        const msg = entry.message as Record<string, unknown> | undefined;
        const role = msg?.role as string;
        if (role === 'toolResult' || role === 'tool') {
          isToolResult = true;
        }
      }

      if (!isToolResult) continue;

      // Count messages since this entry
      const messagesSince = entries.slice(i + 1).filter(e => {
        const t = e.type as string;
        const role = (e.message as Record<string, unknown>)?.role as string | undefined;
        return t === 'message' && (role === 'user' || role === 'assistant');
      }).length;

      if (messagesSince >= threshold) {
        const entryId = entry.id as string;
        if (entryId) toPrune.push(entryId);
      }
    }

    if (toPrune.length === 0) return null;

    // Execute prune
    const sessionFile = join(this.agentsDir, agentId, 'sessions', `${sessionId}.jsonl`);
    const lock = await this.lockService.acquire(sessionFile);

    try {
      const updatedEntries: JsonEntry[] = [];
      const externalized: string[] = [];

      for (const entry of entries) {
        const entryId = entry.id as string;
        if (toPrune.includes(entryId)) {
          // Externalize and replace with stub
          await this.externalStorage.store(agentId, sessionId, entryId, entry);
          externalized.push(entryId);
          updatedEntries.push(this.createPrunedStub(entry));
        } else {
          updatedEntries.push(entry);
        }
      }

      await this.sessionRepo.save(agentId, sessionId, {
        ...session,
        entries: updatedEntries,
      });

      return { pruned: toPrune.length, externalized };
    } finally {
      await lock.release();
    }
  }

  /**
   * Enhanced Pruning: Target specific entry types.
   * - Status calls (type=status)
   * - Old thinking blocks (>10 messages old)
   * - Token/cost entries (immediate)
   */
  async enhancedPrune(
    agentId: string,
    sessionId: string
  ): Promise<{ pruned: number; byType: Record<string, number> }> {
    const sessionFile = join(this.agentsDir, agentId, 'sessions', `${sessionId}.jsonl`);
    const lock = await this.lockService.acquire(sessionFile);

    try {
      const session = await this.sessionRepo.load(agentId, sessionId);
      const entries = session.entries;
      const byType: Record<string, number> = {};

      const updatedEntries = entries.map((entry, i) => {
        const type = entry.type as string;
        const customType = entry.customType as string | undefined;

        // Prune status entries immediately
        if (type === 'custom' && customType === 'status') {
          byType['status'] = (byType['status'] || 0) + 1;
          return this.createPrunedStub(entry);
        }

        // Prune old thinking blocks (>10 messages)
        if (type === 'thinking' || customType === 'thinking') {
          const messagesSince = entries.slice(i + 1).filter(e => {
            const t = e.type as string;
            const role = (e.message as Record<string, unknown>)?.role as string | undefined;
            return t === 'message' && (role === 'user' || role === 'assistant');
          }).length;

          if (messagesSince > 10) {
            byType['thinking'] = (byType['thinking'] || 0) + 1;
            return this.createPrunedStub(entry);
          }
        }

        // Prune token/cost entries immediately
        if (customType === 'token_usage' || customType === 'cost_tracking') {
          byType['token_cost'] = (byType['token_cost'] || 0) + 1;
          return this.createPrunedStub(entry);
        }

        return entry;
      });

      const pruned = Object.values(byType).reduce((a, b) => a + b, 0);

      if (pruned > 0) {
        await this.sessionRepo.save(agentId, sessionId, {
          ...session,
          entries: updatedEntries,
        });
      }

      return { pruned, byType };
    } finally {
      await lock.release();
    }
  }
}
