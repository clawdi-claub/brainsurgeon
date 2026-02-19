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
}
