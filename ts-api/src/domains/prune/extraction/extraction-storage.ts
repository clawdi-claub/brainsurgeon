/**
 * Extraction Storage — filesystem layer for extracted entry data.
 *
 * Layout:
 *   {agentsDir}/{agent}/sessions/extracted/{session-id}/{entry-id}.json
 *
 * Guarantees:
 *   - Directory created on first extraction (mode 0o700)
 *   - Atomic writes (tmp + rename)
 *   - JSON format with __meta header
 */

import { mkdir, writeFile, readFile, readdir, rename, unlink, stat, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLogger } from '../../../shared/logging/logger.js';

const log = createLogger('extraction-storage');

export interface StoredExtraction {
  entryId: string;
  data: Record<string, unknown>;
  sizeBytes: number;
}

export interface ExtractionStorageOptions {
  agentsDir: string;
}

export class ExtractionStorage {
  private agentsDir: string;

  constructor(opts: ExtractionStorageOptions) {
    this.agentsDir = opts.agentsDir;
  }

  /** Expose agentsDir for trash operations. */
  getAgentsDir(): string {
    return this.agentsDir;
  }

  /**
   * Resolve path to the extracted directory for a session.
   */
  extractedDir(agentId: string, sessionId: string): string {
    return join(this.agentsDir, agentId, 'sessions', 'extracted', sessionId);
  }

  /**
   * Resolve path to a specific extracted entry file.
   */
  extractedFile(agentId: string, sessionId: string, entryId: string): string {
    return join(this.extractedDir(agentId, sessionId), `${entryId}.json`);
  }

  /**
   * Store extracted data for an entry. Atomic write (temp + rename).
   * Creates directory with mode 0o700 on first use.
   */
  async store(
    agentId: string,
    sessionId: string,
    entryId: string,
    data: Record<string, unknown>,
  ): Promise<{ filePath: string; sizeBytes: number }> {
    const dir = this.extractedDir(agentId, sessionId);
    // Mode 0o755/0o644 so host user (openclaw) can read files created by
    // container root. The extension's restore_remote runs as openclaw on the host.
    await mkdir(dir, { recursive: true, mode: 0o755 });

    const filePath = this.extractedFile(agentId, sessionId, entryId);
    const json = JSON.stringify(data, null, 2);
    const sizeBytes = Buffer.byteLength(json, 'utf8');

    // Atomic write: write to temp, then rename
    const tmpPath = join(dir, `.tmp-${randomUUID()}.json`);
    await writeFile(tmpPath, json, { encoding: 'utf8', mode: 0o644 });
    await rename(tmpPath, filePath);

    log.debug({ agentId, sessionId, entryId, sizeBytes }, 'stored extracted entry');
    return { filePath, sizeBytes };
  }

  /**
   * Read extracted data for an entry.
   * Returns null if file doesn't exist.
   */
  async read(
    agentId: string,
    sessionId: string,
    entryId: string,
  ): Promise<Record<string, unknown> | null> {
    const filePath = this.extractedFile(agentId, sessionId, entryId);
    try {
      const content = await readFile(filePath, 'utf8');
      return JSON.parse(content);
    } catch (err: any) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  /**
   * List all extracted entry IDs for a session.
   */
  async list(agentId: string, sessionId: string): Promise<string[]> {
    const dir = this.extractedDir(agentId, sessionId);
    try {
      const files = await readdir(dir);
      return files
        .filter(f => f.endsWith('.json') && !f.startsWith('.'))
        .map(f => f.replace('.json', ''));
    } catch (err: any) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  /**
   * Delete a single extracted entry file.
   */
  async delete(agentId: string, sessionId: string, entryId: string): Promise<boolean> {
    const filePath = this.extractedFile(agentId, sessionId, entryId);
    try {
      await unlink(filePath);
      log.debug({ agentId, sessionId, entryId }, 'deleted extracted entry');
      return true;
    } catch (err: any) {
      if (err.code === 'ENOENT') return false;
      throw err;
    }
  }

  /**
   * Delete entire extracted directory for a session.
   * Returns count of files removed.
   */
  async deleteAll(agentId: string, sessionId: string): Promise<number> {
    const dir = this.extractedDir(agentId, sessionId);
    try {
      const files = await readdir(dir);
      const count = files.filter(f => f.endsWith('.json')).length;
      await rm(dir, { recursive: true, force: true });
      log.debug({ agentId, sessionId, count }, 'deleted all extracted entries');
      return count;
    } catch (err: any) {
      if (err.code === 'ENOENT') return 0;
      throw err;
    }
  }

  /**
   * Get total size of extracted files for a session.
   */
  async sessionSize(agentId: string, sessionId: string): Promise<{ files: number; bytes: number }> {
    const dir = this.extractedDir(agentId, sessionId);
    try {
      const files = await readdir(dir);
      const jsonFiles = files.filter(f => f.endsWith('.json') && !f.startsWith('.'));
      let bytes = 0;
      for (const f of jsonFiles) {
        const s = await stat(join(dir, f));
        bytes += s.size;
      }
      return { files: jsonFiles.length, bytes };
    } catch (err: any) {
      if (err.code === 'ENOENT') return { files: 0, bytes: 0 };
      throw err;
    }
  }

  /**
   * Scan all agents/sessions for extracted files with mtime older than cutoff.
   * Used by retention cleanup (SP-07).
   */
  async findExpired(maxAgeMs: number): Promise<Array<{
    agentId: string;
    sessionId: string;
    entryId: string;
    filePath: string;
    ageMs: number;
  }>> {
    const now = Date.now();
    const expired: Array<{
      agentId: string;
      sessionId: string;
      entryId: string;
      filePath: string;
      ageMs: number;
    }> = [];

    try {
      const agents = await readdir(this.agentsDir);
      for (const agentId of agents) {
        const extractedBase = join(this.agentsDir, agentId, 'sessions', 'extracted');
        let sessions: string[];
        try {
          sessions = await readdir(extractedBase);
        } catch {
          continue; // No extracted dir for this agent
        }

        for (const sessionId of sessions) {
          const sessionDir = join(extractedBase, sessionId);
          let files: string[];
          try {
            files = await readdir(sessionDir);
          } catch {
            continue;
          }

          for (const file of files) {
            if (!file.endsWith('.json') || file.startsWith('.')) continue;
            const filePath = join(sessionDir, file);
            try {
              const s = await stat(filePath);
              const ageMs = now - s.mtimeMs;
              if (ageMs >= maxAgeMs) {
                expired.push({
                  agentId,
                  sessionId,
                  entryId: file.replace('.json', ''),
                  filePath,
                  ageMs,
                });
              }
            } catch {
              continue;
            }
          }
        }
      }
    } catch (err: any) {
      log.warn({ err: err.message }, 'error scanning for expired extractions');
    }

    return expired;
  }
}
