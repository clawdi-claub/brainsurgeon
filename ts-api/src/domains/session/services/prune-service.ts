import type { Session, SessionEntry } from '../models/entry.js';
import type { SessionRepository } from '../repository/session-repository.js';
import type { LockService } from '../../lock/services/lock-service.js';

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
    private lockService: LockService
  ) {}

  async execute(agentId: string, sessionId: string, options: PruneOptions = {}): Promise<PruneResult> {
    const { keepRecent = 50, threshold = 3 } = options;
    
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
      const keptEntries: SessionEntry[] = [];
      const externalizedIds: string[] = [];
      
      for (const entry of session.entries) {
        if (toExternalize.includes(entry.id)) {
          // Externalize and replace with stub
          externalizedIds.push(entry.id);
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
      
      // Only process tool_result entries
      if (entry.type !== 'tool_result') continue;
      
      // Check if threshold messages have passed since this entry
      const messagesSince = entries.slice(i + 1).filter(e => 
        e.type === 'message' && (e.role === 'user' || e.role === 'assistant')
      ).length;
      
      if (messagesSince >= threshold) {
        toPrune.push(entry.id);
      }
    }
    
    return toPrune;
  }

  private createStubEntry(entry: SessionEntry): SessionEntry {
    // Replace externalized entry with stub
    if (entry.type === 'tool_result') {
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
