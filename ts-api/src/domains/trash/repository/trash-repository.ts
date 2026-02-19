import { readdir, readFile, rename, access, mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { NotFoundError } from '../../../shared/errors/index.js';

export interface TrashedSession {
  id: string;
  agentId: string;
  deletedAt: number;
  expiresAt: string;
  entryCount: number;
  originalPath: string;
}

interface TrashMeta {
  original_agent: string;
  original_session_id: string;
  original_path: string;
  trashed_at: string;
  expires_at: string;
  parent_session_id?: string;
}

export interface TrashRepository {
  list(): Promise<TrashedSession[]>;
  restore(agentId: string, sessionId: string): Promise<void>;
  deletePermanently(agentId: string, sessionId: string): Promise<void>;
  cleanupExpired(retentionDays?: number): Promise<number>;
}

/**
 * Reads from the Python API-compatible trash directory.
 * Structure: {openclawRoot}/trash/{agent}_{sessionId}_{timestamp}.jsonl
 * With companion .meta.json files.
 */
export class FileSystemTrashRepository implements TrashRepository {
  private trashDir: string;
  private agentsDir: string;

  constructor(agentsDir: string) {
    // Trash dir is at the OpenClaw root level, sibling of agents/
    // agentsDir = /path/.openclaw/agents → trashDir = /path/.openclaw/trash
    this.agentsDir = agentsDir;
    this.trashDir = join(agentsDir, '..', 'trash');
  }

  async list(): Promise<TrashedSession[]> {
    try {
      await access(this.trashDir);
    } catch {
      return [];
    }

    const files = await readdir(this.trashDir);
    const trashed: TrashedSession[] = [];

    for (const file of files) {
      if (!file.endsWith('.meta.json')) continue;

      const metaPath = join(this.trashDir, file);
      try {
        const content = await readFile(metaPath, 'utf8');
        const meta = JSON.parse(content) as TrashMeta;
        const stats = await stat(metaPath);

        // Find the matching jsonl file
        const jsonlFile = file.replace('.meta.json', '.jsonl');
        const jsonlPath = join(this.trashDir, jsonlFile);

        let entryCount = 0;
        try {
          const jsonlContent = await readFile(jsonlPath, 'utf8');
          entryCount = jsonlContent.split('\n').filter(l => l.trim()).length;
        } catch {
          // jsonl file might be missing
        }

        trashed.push({
          id: meta.original_session_id,
          agentId: meta.original_agent,
          deletedAt: stats.mtimeMs,
          expiresAt: meta.expires_at,
          entryCount,
          originalPath: meta.original_path,
        });
      } catch {
        // Skip corrupt meta files
      }
    }

    return trashed.sort((a, b) => b.deletedAt - a.deletedAt);
  }

  async restore(agentId: string, sessionId: string): Promise<void> {
    const { jsonlPath } = await this.findTrashFiles(agentId, sessionId);

    // Restore to original location
    const targetDir = join(this.agentsDir, agentId, 'sessions');
    const targetPath = join(targetDir, `${sessionId}.jsonl`);

    await mkdir(targetDir, { recursive: true });
    await rename(jsonlPath, targetPath);

    // Clean up meta file
    const metaPath = jsonlPath.replace('.jsonl', '.meta.json');
    try { await rm(metaPath); } catch { /* ignore */ }
  }

  async deletePermanently(agentId: string, sessionId: string): Promise<void> {
    const { jsonlPath } = await this.findTrashFiles(agentId, sessionId);

    await rm(jsonlPath);

    // Clean up meta file
    const metaPath = jsonlPath.replace('.jsonl', '.meta.json');
    try { await rm(metaPath); } catch { /* ignore */ }
  }

  async cleanupExpired(): Promise<number> {
    const now = Date.now();
    let cleaned = 0;

    try {
      await access(this.trashDir);
    } catch {
      return 0;
    }

    const files = await readdir(this.trashDir);

    for (const file of files) {
      if (!file.endsWith('.meta.json')) continue;

      const metaPath = join(this.trashDir, file);
      try {
        const content = await readFile(metaPath, 'utf8');
        const meta = JSON.parse(content) as TrashMeta;
        const expiresAt = new Date(meta.expires_at).getTime();

        if (expiresAt < now) {
          const jsonlFile = file.replace('.meta.json', '.jsonl');
          const jsonlPath = join(this.trashDir, jsonlFile);
          try { await rm(jsonlPath); } catch { /* ignore */ }
          await rm(metaPath);
          cleaned++;
        }
      } catch {
        // Skip corrupt files
      }
    }

    return cleaned;
  }

  /**
   * Find trash files matching agent + sessionId.
   * Files are named: {agent}_{sessionId}_{timestamp}.jsonl
   */
  private async findTrashFiles(
    agentId: string,
    sessionId: string
  ): Promise<{ jsonlPath: string }> {
    try {
      await access(this.trashDir);
    } catch {
      throw new NotFoundError('Trashed session', `${agentId}/${sessionId}`);
    }

    const prefix = `${agentId}_${sessionId}_`;
    const files = await readdir(this.trashDir);
    const match = files.find(f => f.startsWith(prefix) && f.endsWith('.jsonl'));

    if (!match) {
      throw new NotFoundError('Trashed session', `${agentId}/${sessionId}`);
    }

    return { jsonlPath: join(this.trashDir, match) };
  }
}
