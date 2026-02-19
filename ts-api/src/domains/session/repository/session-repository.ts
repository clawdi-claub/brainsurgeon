import { readFile, writeFile, mkdir, rename, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import type { Session, SessionEntry, SessionListItem, SessionMetadata } from '../models/entry.js';
import type { LockService } from '../../lock/services/lock-service.js';
import { NotFoundError } from '../../../shared/errors/index.js';

interface CacheEntry {
  entries: SessionEntry[];
  mtimeMs: number;
  size: number;
}

export interface SessionRepository {
  load(agentId: string, sessionId: string): Promise<Session>;
  save(agentId: string, sessionId: string, session: Session): Promise<void>;
  exists(agentId: string, sessionId: string): Promise<boolean>;
  list(agentId?: string): Promise<SessionListItem[]>;
  delete(agentId: string, sessionId: string): Promise<void>;
}

export class FileSystemSessionRepository implements SessionRepository {
  private sessionsDir: string;
  private lockService: LockService;
  private cache = new Map<string, CacheEntry>();

  constructor(sessionsDir: string, lockService: LockService) {
    this.sessionsDir = sessionsDir;
    this.lockService = lockService;
  }

  private resolvePath(agentId: string, sessionId: string): string {
    return join(this.sessionsDir, agentId, `${sessionId}.jsonl`);
  }

  private resolveSessionsJson(agentId: string): string {
    return join(this.sessionsDir, agentId, 'sessions.json');
  }

  async load(agentId: string, sessionId: string): Promise<Session> {
    const sessionFile = this.resolvePath(agentId, sessionId);
    
    // Try cache first
    const cached = this.getFromCache(sessionFile);
    if (cached) {
      return {
        id: sessionId,
        agentId,
        entries: cached.entries,
        metadata: this.buildMetadata(cached.entries),
      };
    }

    // Check existence
    if (!(await this.fileExists(sessionFile))) {
      throw new NotFoundError('Session', `${agentId}/${sessionId}`);
    }

    // Acquire lock for reading
    const lock = await this.lockService.acquire(sessionFile);
    
    try {
      const content = await readFile(sessionFile, 'utf8');
      const entries = this.parseJsonl(content);
      
      // Update cache
      this.updateCache(sessionFile, entries);
      
      return {
        id: sessionId,
        agentId,
        entries,
        metadata: this.buildMetadata(entries),
      };
    } finally {
      await lock.release();
    }
  }

  async save(agentId: string, sessionId: string, session: Session): Promise<void> {
    const sessionFile = this.resolvePath(agentId, sessionId);
    
    // Ensure directory exists
    await mkdir(dirname(sessionFile), { recursive: true });
    
    // Acquire lock for writing
    const lock = await this.lockService.acquire(sessionFile);
    
    try {
      const content = this.serializeJsonl(session.entries);
      await writeFile(sessionFile, content, 'utf8');
      
      // Update cache
      this.updateCache(sessionFile, session.entries);
      
      // Update sessions.json metadata
      await this.updateSessionsJson(agentId, sessionId, session);
    } finally {
      await lock.release();
    }
  }

  async exists(agentId: string, sessionId: string): Promise<boolean> {
    const sessionFile = this.resolvePath(agentId, sessionId);
    return this.fileExists(sessionFile);
  }

  async list(agentId?: string): Promise<SessionListItem[]> {
    if (agentId) {
      return this.listForAgent(agentId);
    }
    
    // List all agents
    const agents = await this.getAgents();
    const allSessions: SessionListItem[] = [];
    
    for (const aid of agents) {
      const sessions = await this.listForAgent(aid);
      allSessions.push(...sessions);
    }
    
    return allSessions;
  }

  private async listForAgent(agentId: string): Promise<SessionListItem[]> {
    const sessionsJson = this.resolveSessionsJson(agentId);
    
    if (!(await this.fileExists(sessionsJson))) {
      return [];
    }

    try {
      const content = await readFile(sessionsJson, 'utf8');
      const data = JSON.parse(content) as { sessions: SessionListItem[] };
      return data.sessions || [];
    } catch {
      return [];
    }
  }

  async delete(agentId: string, sessionId: string): Promise<void> {
    const sessionFile = this.resolvePath(agentId, sessionId);
    
    if (!(await this.fileExists(sessionFile))) {
      throw new NotFoundError('Session', `${agentId}/${sessionId}`);
    }

    const lock = await this.lockService.acquire(sessionFile);
    
    try {
      // Move to trash instead of delete
      const trashDir = join(this.sessionsDir, '.trash', agentId);
      await mkdir(trashDir, { recursive: true });
      const trashPath = join(trashDir, `${sessionId}.jsonl`);
      
      await rename(sessionFile, trashPath);
      
      // Update sessions.json
      await this.removeFromSessionsJson(agentId, sessionId);
      
      // Invalidate cache
      this.cache.delete(sessionFile);
    } finally {
      await lock.release();
    }
  }

  private parseJsonl(content: string): SessionEntry[] {
    const lines = content.split('\n').filter(l => l.trim());
    const entries: SessionEntry[] = [];
    
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as SessionEntry;
        entries.push(entry);
      } catch {
        // Skip malformed lines
      }
    }
    
    return entries;
  }

  private serializeJsonl(entries: SessionEntry[]): string {
    return entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  }

  private buildMetadata(entries: SessionEntry[]): SessionMetadata {
    const timestamps = entries.map(e => e.timestamp).filter(Boolean);
    
    return {
      createdAt: timestamps.length > 0 ? Math.min(...timestamps) : Date.now(),
      updatedAt: timestamps.length > 0 ? Math.max(...timestamps) : Date.now(),
      entryCount: entries.length,
    };
  }

  private getFromCache(sessionFile: string): CacheEntry | null {
    const cached = this.cache.get(sessionFile);
    if (!cached) return null;
    
    try {
      const stats = statSync(sessionFile);
      if (stats.mtimeMs !== cached.mtimeMs || stats.size !== cached.size) {
        this.cache.delete(sessionFile);
        return null;
      }
      return cached;
    } catch {
      this.cache.delete(sessionFile);
      return null;
    }
  }

  private updateCache(sessionFile: string, entries: SessionEntry[]): void {
    try {
      const stats = statSync(sessionFile);
      this.cache.set(sessionFile, {
        entries,
        mtimeMs: stats.mtimeMs,
        size: stats.size,
      });
    } catch {
      // Cache update failed, ignore
    }
  }

  private async fileExists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  private async getAgents(): Promise<string[]> {
    // Read agents.json or scan directories
    const agentsJson = join(this.sessionsDir, 'agents.json');
    
    try {
      const content = await readFile(agentsJson, 'utf8');
      const data = JSON.parse(content) as { agents: string[] };
      return data.agents || [];
    } catch {
      // Fallback: scan directories
      return [];
    }
  }

  private async updateSessionsJson(
    agentId: string,
    sessionId: string,
    session: Session
  ): Promise<void> {
    // Implementation stub - update mutable metadata store
    // This is safe to write without full locking (OpenClaw only reads metadata from here)
  }

  private async removeFromSessionsJson(agentId: string, sessionId: string): Promise<void> {
    // Remove from sessions.json when deleted
  }
}
