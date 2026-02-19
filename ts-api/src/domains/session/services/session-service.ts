import type { Session, SessionEntry, SessionListItem, SessionMetadata } from '../models/entry.js';
import type { SessionRepository } from '../repository/session-repository.js';
import type { LockService } from '../../lock/services/lock-service.js';
import { NotFoundError } from '../../../shared/errors/index.js';

export interface SummaryResult {
  summary: string;
  messageCount: number;
  toolCallCount: number;
  tokenCount: number;
}

export class SessionService {
  constructor(
    private sessionRepo: SessionRepository,
    private lockService: LockService
  ) {}

  async getSession(agentId: string, sessionId: string): Promise<Session> {
    return this.sessionRepo.load(agentId, sessionId);
  }

  async listSessions(agentId?: string): Promise<SessionListItem[]> {
    return this.sessionRepo.list(agentId);
  }

  async deleteSession(agentId: string, sessionId: string): Promise<void> {
    const exists = await this.sessionRepo.exists(agentId, sessionId);
    if (!exists) {
      throw new NotFoundError('Session', `${agentId}/${sessionId}`);
    }
    await this.sessionRepo.delete(agentId, sessionId);
  }

  async getSummary(agentId: string, sessionId: string): Promise<SummaryResult> {
    const session = await this.sessionRepo.load(agentId, sessionId);
    
    const messageEntries = session.entries.filter(e => e.type === 'message');
    const toolCallEntries = session.entries.filter(e => e.type === 'tool_call');
    
    // Calculate tokens (approximate)
    let tokenCount = 0;
    for (const entry of messageEntries) {
      if ('content' in entry && Array.isArray(entry.content)) {
        for (const block of entry.content) {
          if (block.type === 'text' && 'text' in block) {
            tokenCount += Math.ceil(block.text.length / 4); // Rough estimate
          }
        }
      }
    }

    // Generate simple summary
    const summary = this.generateSummary(session.entries);

    return {
      summary,
      messageCount: messageEntries.length,
      toolCallCount: toolCallEntries.length,
      tokenCount,
    };
  }

  async editEntry(
    agentId: string,
    sessionId: string,
    entryId: string,
    updates: Partial<SessionEntry>
  ): Promise<void> {
    const lock = await this.lockService.acquire(
      this.resolveSessionFile(agentId, sessionId)
    );

    try {
      const session = await this.sessionRepo.load(agentId, sessionId);
      
      const entryIndex = session.entries.findIndex(e => e.id === entryId);
      if (entryIndex === -1) {
        throw new NotFoundError('Entry', entryId);
      }

      session.entries[entryIndex] = {
        ...session.entries[entryIndex],
        ...updates,
      };

      await this.sessionRepo.save(agentId, sessionId, session);
    } finally {
      await lock.release();
    }
  }

  private generateSummary(entries: SessionEntry[]): string {
    // Basic summary - first user message + last assistant message
    const firstUser = entries.find(e => e.type === 'message' && e.role === 'user');
    const lastAssistant = entries.reverse().find(e => e.type === 'message' && e.role === 'assistant');
    
    let summary = '';
    
    if (firstUser) {
      const text = this.extractText(firstUser);
      summary += `Started with: "${text.slice(0, 100)}${text.length > 100 ? '...' : ''}"\n`;
    }
    
    if (lastAssistant) {
      const text = this.extractText(lastAssistant);
      summary += `Ended with: "${text.slice(0, 100)}${text.length > 100 ? '...' : ''}"`;
    }
    
    return summary || 'Session summary not available';
  }

  private extractText(entry: SessionEntry): string {
    if (entry.type !== 'message' || !Array.isArray(entry.content)) {
      return '';
    }
    
    for (const block of entry.content) {
      if (block.type === 'text' && 'text' in block) {
        return block.text;
      }
    }
    return '';
  }

  private resolveSessionFile(agentId: string, sessionId: string): string {
    return `/home/openclaw/.openclaw/sessions/${agentId}/${sessionId}.jsonl`;
  }
}
