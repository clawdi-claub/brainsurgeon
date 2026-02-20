import { readFile, writeFile, mkdir, rename, access, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import type { Session, SessionListItem, SessionMetadata, JsonEntry } from '../models/entry.js';
import type { LockService } from '../../lock/services/lock-service.js';
import { NotFoundError } from '../../../shared/errors/index.js';
import { createLogger } from '../../../shared/logging/logger.js';

const log = createLogger('session-repo');

interface CacheEntry {
  entries: JsonEntry[];
  mtimeMs: number;
  size: number;
}

/** OpenClaw sessions.json entry (map values) */
interface OpenClawSessionMeta {
  sessionId: string;
  updatedAt?: number;
  chatType?: string;
  lastChannel?: string;
  totalTokens?: number;
  contextTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  compactionCount?: number;
  parentSessionId?: string;
  deliveryContext?: {
    channel?: string;
  };
  origin?: {
    label?: string;
  };
  systemPromptReport?: unknown;
  skillsSnapshot?: {
    resolvedSkills?: Array<{ name?: string } | string>;
  };
}

export interface SessionRepository {
  load(agentId: string, sessionId: string): Promise<Session>;
  save(agentId: string, sessionId: string, session: Session): Promise<void>;
  exists(agentId: string, sessionId: string): Promise<boolean>;
  list(agentId?: string): Promise<SessionListItem[]>;
  delete(agentId: string, sessionId: string): Promise<void>;
  findChildren(agentId: string, sessionId: string): Promise<Array<{ sessionId: string; label: string }>>;
}

/**
 * Reads OpenClaw session files from the agents directory.
 * Structure: {agentsDir}/{agent}/sessions/{sessionId}.jsonl
 */
export class FileSystemSessionRepository implements SessionRepository {
  private agentsDir: string;
  private lockService: LockService;
  private cache = new Map<string, CacheEntry>();

  constructor(agentsDir: string, lockService: LockService) {
    this.agentsDir = agentsDir;
    this.lockService = lockService;
  }

  private resolvePath(agentId: string, sessionId: string): string {
    return join(this.agentsDir, agentId, 'sessions', `${sessionId}.jsonl`);
  }

  private resolveSessionsJson(agentId: string): string {
    return join(this.agentsDir, agentId, 'sessions', 'sessions.json');
  }

  async load(agentId: string, sessionId: string): Promise<Session> {
    const sessionFile = this.resolvePath(agentId, sessionId);
    log.debug({ agentId, sessionId }, 'loading session');

    // Check existence first
    if (!(await this.fileExists(sessionFile))) {
      throw new NotFoundError('Session', `${agentId}/${sessionId}`);
    }

    // Try cache
    const cached = this.getFromCache(sessionFile);
    const rawMeta = await this.lookupRawMeta(agentId, sessionId);

    if (cached) {
      log.debug({ agentId, sessionId, entries: cached.entries.length }, 'loaded from cache');
      return {
        id: sessionId,
        agentId,
        entries: cached.entries,
        metadata: this.buildMetadata(cached.entries),
        rawMeta,
      };
    }

    // Acquire lock for reading
    const lock = await this.lockService.acquire(sessionFile);

    try {
      const content = await readFile(sessionFile, 'utf8');
      const entries = this.parseJsonl(content);

      this.updateCache(sessionFile, entries);

      return {
        id: sessionId,
        agentId,
        entries,
        metadata: this.buildMetadata(entries),
        rawMeta,
      };
    } finally {
      await lock.release();
    }
  }

  /** Look up raw metadata from sessions.json for a given sessionId */
  private async lookupRawMeta(
    agentId: string,
    sessionId: string
  ): Promise<Session['rawMeta'] | undefined> {
    const sessionsJson = this.resolveSessionsJson(agentId);

    try {
      const content = await readFile(sessionsJson, 'utf8');
      const data = JSON.parse(content) as Record<string, OpenClawSessionMeta>;

      const entry = Object.values(data).find(m => m.sessionId === sessionId);
      if (!entry) return undefined;

      // Resolve skills: handle both {name: string}[] and string[]
      const skills = entry.skillsSnapshot?.resolvedSkills ?? [];
      const resolvedSkills: string[] = skills.map((s) =>
        typeof s === 'string' ? s : (s.name ?? 'unknown')
      );

      // systemPromptReport: stringify if object
      const systemPromptReport =
        entry.systemPromptReport == null
          ? undefined
          : typeof entry.systemPromptReport === 'string'
          ? entry.systemPromptReport
          : JSON.stringify(entry.systemPromptReport, null, 2);

      return {
        channel: entry.lastChannel || entry.deliveryContext?.channel,
        tokens: entry.totalTokens,
        contextTokens: entry.contextTokens,
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        parentSessionId: entry.parentSessionId,
        compactionCount: entry.compactionCount,
        systemPromptReport,
        resolvedSkills,
      };
    } catch {
      return undefined;
    }
  }

  async save(agentId: string, sessionId: string, session: Session): Promise<void> {
    const sessionFile = this.resolvePath(agentId, sessionId);
    log.debug({ agentId, sessionId, entries: session.entries.length }, 'saving session');
    
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
      const data = JSON.parse(content) as Record<string, OpenClawSessionMeta>;

      // OpenClaw sessions.json is a map of sessionKey -> metadata
      const items: SessionListItem[] = [];

      for (const [key, meta] of Object.entries(data)) {
        if (!meta.sessionId) continue;

        // Skip sessions without JSONL files (e.g. cleaned-up subagent sessions)
        const sessionFile = this.resolvePath(agentId, meta.sessionId);
        if (!(await this.fileExists(sessionFile))) continue;

        // Analyze the JSONL file for accurate stats
        const stats = await this.analyzeJsonl(agentId, meta.sessionId);

        items.push({
          id: meta.sessionId,
          agentId,
          title: meta.origin?.label || key,
          createdAt: 0,
          updatedAt: meta.updatedAt || 0,
          entryCount: stats.entryCount,
          sizeBytes: stats.sizeBytes,
          status: 'active',
          currentModel: stats.models[0],
          modelsUsed: stats.models,
          toolCallCount: stats.toolCallCount,
          messageCount: stats.messages,
          toolOutputCount: stats.toolOutputs,
          rawMeta: {
            channel: meta.lastChannel || meta.deliveryContext?.channel,
            tokens: meta.totalTokens,
            contextTokens: meta.contextTokens,
            inputTokens: meta.inputTokens,
            outputTokens: meta.outputTokens,
            parentSessionId: meta.parentSessionId,
            compactionCount: meta.compactionCount,
          },
        });
      }

      return items.sort((a, b) => b.updatedAt - a.updatedAt);
    } catch {
      return [];
    }
  }

  /** Analyze a JSONL file for stats (matching Python API behavior) */
  private async analyzeJsonl(agentId: string, sessionId: string): Promise<{
    entryCount: number;
    toolCallCount: number;
    messages: number;
    toolOutputs: number;
    models: string[];
    sizeBytes: number;
  }> {
    const sessionFile = this.resolvePath(agentId, sessionId);

    try {
      const fileStats = statSync(sessionFile);
      const content = await readFile(sessionFile, 'utf8');
      const entries = this.parseJsonl(content);

      let messages = 0;
      let toolCalls = 0;
      let toolOutputs = 0;
      const models = new Set<string>();

      for (const entry of entries) {
        const entryType = entry.type as string;

        if (entryType === 'message') {
          const msg = entry.message as Record<string, unknown> | undefined;
          if (!msg) continue;

          const role = msg.role as string;
          if (role === 'user' || role === 'assistant') messages++;
          if (role === 'toolResult') toolOutputs++;

          const model = msg.model as string | undefined;
          if (model) models.add(model);

          // Count toolCall items in content array
          const content = msg.content;
          if (Array.isArray(content)) {
            for (const item of content) {
              if (item && typeof item === 'object' && (item as Record<string, unknown>).type === 'toolCall') {
                toolCalls++;
              }
            }
          }
        } else if (entryType === 'tool_call') {
          toolCalls++;
        } else if (entryType === 'tool_result' || entryType === 'tool') {
          toolOutputs++;
        }
      }

      return {
        entryCount: entries.length,
        toolCallCount: toolCalls,
        messages,
        toolOutputs,
        models: Array.from(models),
        sizeBytes: fileStats.size,
      };
    } catch {
      return {
        entryCount: 0,
        toolCallCount: 0,
        messages: 0,
        toolOutputs: 0,
        models: [],
        sizeBytes: 0,
      };
    }
  }

  async delete(agentId: string, sessionId: string): Promise<void> {
    const sessionFile = this.resolvePath(agentId, sessionId);

    if (!(await this.fileExists(sessionFile))) {
      throw new NotFoundError('Session', `${agentId}/${sessionId}`);
    }

    const lock = await this.lockService.acquire(sessionFile);

    try {
      // Move to trash: {agentsDir}/.trash/{agent}/{sessionId}.jsonl
      const trashDir = join(this.agentsDir, '.trash', agentId);
      await mkdir(trashDir, { recursive: true });
      const trashPath = join(trashDir, `${sessionId}.jsonl`);

      await rename(sessionFile, trashPath);

      // Remove from sessions.json
      await this.removeFromSessionsJson(agentId, sessionId);

      // Invalidate cache
      this.cache.delete(sessionFile);
    } finally {
      await lock.release();
    }
  }

  async findChildren(agentId: string, sessionId: string): Promise<Array<{ sessionId: string; label: string }>> {
    const sessionsJson = this.resolveSessionsJson(agentId);
    try {
      const content = await readFile(sessionsJson, 'utf8');
      const data = JSON.parse(content) as Record<string, OpenClawSessionMeta>;
      const children: Array<{ sessionId: string; label: string }> = [];
      for (const [key, meta] of Object.entries(data)) {
        if (meta.parentSessionId === sessionId && meta.sessionId) {
          children.push({
            sessionId: meta.sessionId,
            label: meta.origin?.label || key,
          });
        }
      }
      return children;
    } catch {
      return [];
    }
  }

  private parseJsonl(content: string): JsonEntry[] {
    const lines = content.split('\n').filter(l => l.trim());
    const entries: JsonEntry[] = [];
    
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as JsonEntry;
        entries.push(entry);
      } catch {
        // Skip malformed lines
      }
    }
    
    return entries;
  }

  private serializeJsonl(entries: JsonEntry[]): string {
    return entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  }

  private buildMetadata(entries: JsonEntry[]): SessionMetadata {
    const timestamps = entries
      .map(e => e.timestamp as number | undefined)
      .filter((t): t is number => typeof t === 'number' && t > 0);
    
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

  private updateCache(sessionFile: string, entries: JsonEntry[]): void {
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
    try {
      const entries = await readdir(this.agentsDir, { withFileTypes: true });
      return entries
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .map(e => e.name);
    } catch {
      return [];
    }
  }

  /**
   * Updates sessions.json metadata after save.
   * Note: sessions.json is OpenClaw's map format { key: { sessionId, ... } }
   * We only update the updatedAt timestamp, not restructure the file.
   */
  private async updateSessionsJson(
    _agentId: string,
    _sessionId: string,
    _session: Session
  ): Promise<void> {
    // BrainSurgeon does not update sessions.json on save.
    // OpenClaw manages this file; we only read from it.
    // Modifying it on edit/prune could corrupt OpenClaw state.
  }

  /**
   * Removes a session entry from sessions.json on delete.
   * Matches Python API behavior: removes all keys where sessionId matches.
   */
  private async removeFromSessionsJson(agentId: string, sessionId: string): Promise<void> {
    const sessionsJsonPath = this.resolveSessionsJson(agentId);

    try {
      const content = await readFile(sessionsJsonPath, 'utf8');
      const data = JSON.parse(content) as Record<string, OpenClawSessionMeta>;

      const keysToRemove = Object.keys(data).filter(
        k => data[k].sessionId === sessionId
      );

      if (keysToRemove.length === 0) return;

      for (const key of keysToRemove) {
        delete data[key];
      }

      await writeFile(sessionsJsonPath, JSON.stringify(data, null, 2), 'utf8');
    } catch {
      // File doesn't exist or is malformed
    }
  }
}
