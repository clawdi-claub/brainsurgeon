import { readdir, readFile, rename, access, mkdir, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { NotFoundError } from '../../../shared/errors/index.js';

export interface TrashedSession {
  id: string;
  agentId: string;
  deletedAt: number;
  entryCount: number;
  originalPath: string;
}

export interface TrashRepository {
  list(): Promise<TrashedSession[]>;
  restore(agentId: string, sessionId: string): Promise<void>;
  deletePermanently(agentId: string, sessionId: string): Promise<void>;
  cleanupExpired(retentionDays?: number): Promise<number>;
}

export class FileSystemTrashRepository implements TrashRepository {
  constructor(
    private sessionsDir: string
  ) {}

  private getTrashDir(): string {
    return join(this.sessionsDir, '.trash');
  }

  async list(): Promise<TrashedSession[]> {
    const trashDir = this.getTrashDir();
    
    try {
      await access(trashDir);
    } catch {
      return [];
    }

    const trashed: TrashedSession[] = [];
    const agents = await readdir(trashDir);

    for (const agentId of agents) {
      const agentDir = join(trashDir, agentId);
      const files = await readdir(agentDir).catch(() => []);

      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        
        const sessionId = file.replace('.jsonl', '');
        const filePath = join(agentDir, file);
        
        try {
          const content = await readFile(filePath, 'utf8');
          const entries = content.split('\n').filter(l => l.trim());
          
          const stats = await import('node:fs/promises').then(m => m.stat(filePath));
          
          trashed.push({
            id: sessionId,
            agentId,
            deletedAt: stats.mtimeMs,
            entryCount: entries.length,
            originalPath: filePath,
          });
        } catch {
          // Skip corrupt files
        }
      }
    }

    return trashed.sort((a, b) => b.deletedAt - a.deletedAt);
  }

  async restore(agentId: string, sessionId: string): Promise<void> {
    const trashPath = join(this.getTrashDir(), agentId, `${sessionId}.jsonl`);
    const targetDir = join(this.sessionsDir, agentId);
    const targetPath = join(targetDir, `${sessionId}.jsonl`);

    try {
      await access(trashPath);
    } catch {
      throw new NotFoundError('Trashed session', `${agentId}/${sessionId}`);
    }

    await mkdir(targetDir, { recursive: true });
    await rename(trashPath, targetPath);
  }

  async deletePermanently(agentId: string, sessionId: string): Promise<void> {
    const trashPath = join(this.getTrashDir(), agentId, `${sessionId}.jsonl`);

    try {
      await access(trashPath);
    } catch {
      throw new NotFoundError('Trashed session', `${agentId}/${sessionId}`);
    }

    await rm(trashPath);
  }

  async cleanupExpired(retentionDays = 14): Promise<number> {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const trashDir = this.getTrashDir();
    let cleaned = 0;

    try {
      await access(trashDir);
    } catch {
      return 0;
    }

    const agents = await readdir(trashDir);

    for (const agentId of agents) {
      const agentDir = join(trashDir, agentId);
      const files = await readdir(agentDir).catch(() => []);

      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        const filePath = join(agentDir, file);

        try {
          const { stat } = await import('node:fs/promises');
          const stats = await stat(filePath);
          if (stats.mtimeMs < cutoff) {
            await rm(filePath);
            cleaned++;
          }
        } catch {
          // Skip files we can't stat
        }
      }
    }

    return cleaned;
  }
}
