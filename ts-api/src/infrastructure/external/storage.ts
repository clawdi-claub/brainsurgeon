// External file storage for pruned/compressed content
// Stores in {sessionsDir}/{agent}/external/

import { mkdir, writeFile, readFile, readdir, access, rm, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLogger } from '../../shared/logging/logger.js';

const log = createLogger('external-storage');

interface StoredEntry {
  id: string;
  agentId: string;
  sessionId: string;
  storedAt: number;
  originalEntry: unknown;
}

interface StorageConfig {
  sessionsDir: string;
  ttlDays?: number; // Time-to-live for unrestored entries
}

/**
 * External storage for pruned session entries
 * Moves large content out of main session file
 * Rehydrates on demand via restore_response tool
 */
export class ExternalStorage {
  private config: StorageConfig;

  constructor(config: StorageConfig) {
    this.config = { ttlDays: 30, ...config };
  }

  private getExternalDir(agentId: string): string {
    return join(this.config.sessionsDir, agentId, 'external');
  }

  private getKeepListPath(agentId: string): string {
    return join(this.getExternalDir(agentId), '.kept-entries.json');
  }

  /**
   * Store entry in external storage
   * Returns the external ID for reference
   */
  async store(
    agentId: string,
    sessionId: string,
    entryId: string,
    content: unknown
  ): Promise<string> {
    const externalDir = this.getExternalDir(agentId);
    await mkdir(externalDir, { recursive: true });

    const storedEntry: StoredEntry = {
      id: entryId,
      agentId,
      sessionId,
      storedAt: Date.now(),
      originalEntry: content,
    };

    const filePath = join(externalDir, `${entryId}.json`);
    await writeFile(filePath, JSON.stringify(storedEntry, null, 2), 'utf8');
    log.debug({ agentId, sessionId, entryId }, 'stored entry externally');

    // Update keep list
    await this.updateKeepList(agentId, entryId);

    return entryId;
  }

  /**
   * Retrieve entry from external storage
   */
  async retrieve(agentId: string, entryId: string): Promise<unknown | null> {
    const filePath = join(this.getExternalDir(agentId), `${entryId}.json`);

    try {
      await access(filePath);
    } catch {
      return null;
    }

    const content = await readFile(filePath, 'utf8');
    const stored = JSON.parse(content) as StoredEntry;
    log.debug({ agentId, entryId }, 'retrieved entry from external storage');
    return stored.originalEntry;
  }

  /**
   * Check if entry exists in external storage
   */
  async exists(agentId: string, entryId: string): Promise<boolean> {
    const filePath = join(this.getExternalDir(agentId), `${entryId}.json`);

    try {
      await access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Delete entry from external storage
   * Called after successful rehydration
   */
  async delete(agentId: string, entryId: string): Promise<void> {
    const filePath = join(this.getExternalDir(agentId), `${entryId}.json`);

    try {
      await rm(filePath);
    } catch {
      // Already deleted or doesn't exist
    }
  }

  /**
   * Get all externalized entry IDs for an agent
   */
  async list(agentId: string): Promise<string[]> {
    const keepListPath = this.getKeepListPath(agentId);

    try {
      const content = await readFile(keepListPath, 'utf8');
      const data = JSON.parse(content) as { entries: string[] };
      return data.entries || [];
    } catch {
      return [];
    }
  }

  /**
   * Cleanup entries older than TTL.
   * Scans all agent external/ directories and deletes expired .json files.
   */
  async cleanup(): Promise<number> {
    const ttlMs = (this.config.ttlDays || 30) * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - ttlMs;
    let deleted = 0;

    log.debug({ ttlDays: this.config.ttlDays, cutoff: new Date(cutoff).toISOString() }, 'starting cleanup');

    // Scan all agent directories
    let agents: string[];
    try {
      const entries = await readdir(this.config.sessionsDir, { withFileTypes: true });
      agents = entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name);
    } catch {
      log.debug('no agents directory found');
      return 0;
    }

    for (const agentId of agents) {
      const externalDir = this.getExternalDir(agentId);

      let files: string[];
      try {
        const entries = await readdir(externalDir);
        files = entries.filter(f => f.endsWith('.json') && !f.startsWith('.'));
      } catch {
        // No external directory for this agent
        continue;
      }

      for (const file of files) {
        const filePath = join(externalDir, file);
        try {
          const fileStat = await stat(filePath);
          if (fileStat.mtimeMs < cutoff) {
            await rm(filePath);
            deleted++;
            log.debug({ agentId, file, age: Math.round((Date.now() - fileStat.mtimeMs) / 86400000) }, 'deleted expired file');
          }
        } catch (err: any) {
          log.error({ agentId, file, err: err.message }, 'error checking/deleting file');
        }
      }

      // Clean up keep list — remove entries for deleted files
      if (deleted > 0) {
        try {
          const keepEntries = await this.list(agentId);
          const remaining = [];
          for (const entryId of keepEntries) {
            if (await this.exists(agentId, entryId)) {
              remaining.push(entryId);
            }
          }
          if (remaining.length !== keepEntries.length) {
            await writeFile(
              this.getKeepListPath(agentId),
              JSON.stringify({ entries: remaining }, null, 2),
              'utf8'
            );
          }
        } catch {
          // Keep list doesn't exist or is corrupted
        }
      }
    }

    log.info({ deleted }, 'cleanup completed');
    return deleted;
  }

  private async updateKeepList(agentId: string, entryId: string): Promise<void> {
    const keepListPath = this.getKeepListPath(agentId);
    const entries = await this.list(agentId);

    if (!entries.includes(entryId)) {
      entries.push(entryId);
      await writeFile(
        keepListPath,
        JSON.stringify({ entries }, null, 2),
        'utf8'
      );
    }
  }
}
