// External file storage for pruned/compressed content
// Stores in {sessionsDir}/{agent}/external/

import { mkdir, writeFile, readFile, access, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

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
   * Cleanup entries older than TTL
   * Should be called periodically
   */
  async cleanup(): Promise<number> {
    const ttlMs = (this.config.ttlDays || 30) * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - ttlMs;
    let deleted = 0;

    // This is a stub - would need to scan all external directories
    // and check mtime of each file

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
