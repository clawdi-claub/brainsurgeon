import type { Session, JsonEntry } from '../models/entry.js';
import type { SessionRepository } from '../repository/session-repository.js';
import type { LockService } from '../../lock/services/lock-service.js';
import type { ExternalStorage } from '../../../infrastructure/external/storage.js';

export interface PruneOptions {
  keepRecent?: number;        // Keep last N entries
  removeToolResults?: boolean; // Remove tool result content
  threshold?: number;         // Messages since tool response before externalizing
}

export interface PruneResult {
  externalized: number;
  kept: number;
  externalizedIds: string[];
}

export class PruneService {
  constructor(
    private sessionRepo: SessionRepository,
    private lockService: LockService,
    private externalStorage: ExternalStorage
  ) {}

  async execute(agentId: string, sessionId: string, options: PruneOptions = {}): Promise<PruneResult> {
    const { threshold = 3 } = options;
    
    // Load session with lock
    const sessionFile = this.resolveSessionFile(agentId, sessionId);
    const lock = await this.lockService.acquire(sessionFile);
    
    try {
      const session = await this.sessionRepo.load(agentId, sessionId);
      
      // Identify entries to externalize
      const toExternalize = this.identifyPrunableEntries(session, threshold);
      
      if (toExternalize.length === 0) {
        return { externalized: 0, kept: session.entries.length, externalizedIds: [] };
      }

      // Externalize tool results
      const keptEntries: JsonEntry[] = [];
      const externalizedIds: string[] = [];
      
      for (const entry of session.entries) {
        const entryId = entry.id as string;
        if (toExternalize.includes(entryId) && entry.type === 'tool_result') {
          // Store full content externally
          await this.externalStorage.store(agentId, sessionId, entryId, entry);
          
          externalizedIds.push(entryId);
          keptEntries.push(this.createStubEntry(entry));
        } else {
          keptEntries.push(entry);
        }
      }

      // Save pruned session
      await this.sessionRepo.save(agentId, sessionId, {
        ...session,
        entries: keptEntries,
      });

      return {
        externalized: toExternalize.length,
        kept: keptEntries.length,
        externalizedIds,
      };
    } finally {
      await lock.release();
    }
  }

  /**
   * Identify entries that can be pruned
   * Strategy: Externalize tool results after threshold messages
   */
  private identifyPrunableEntries(session: Session, threshold: number): string[] {
    const toPrune: string[] = [];
    const entries = session.entries;
    
    // Find all tool results
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const entryType = entry.type as string;
      
      // Only process tool_result entries
      if (entryType !== 'tool_result') continue;
      
      // Check if threshold messages have passed since this entry
      const messagesSince = entries.slice(i + 1).filter(e => {
        const t = e.type as string;
        const role = (e.message as Record<string, unknown>)?.role as string | undefined;
        return t === 'message' && (role === 'user' || role === 'assistant');
      }).length;
      
      if (messagesSince >= threshold) {
        toPrune.push(entry.id as string);
      }
    }
    
    return toPrune;
  }

  private createStubEntry(entry: JsonEntry): JsonEntry {
    // Replace externalized entry with stub
    if ((entry.type as string) === 'tool_result') {
      return {
        ...entry,
        content: [{ type: 'text', text: '[Content externalized - use restore_response tool]' }],
      };
    }
    return entry;
  }

  private resolveSessionFile(agentId: string, sessionId: string): string {
    // This is a hack - repo should expose this
    // TODO: Add getSessionPath to repository interface
    return `/home/openclaw/.openclaw/sessions/${agentId}/${sessionId}.jsonl`;
  }
}
