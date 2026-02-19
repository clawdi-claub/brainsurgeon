import { mkdir, rm, stat, readFile } from 'node:fs/promises';
import { open } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { LockHandle, LockService } from '../services/lock-service.js';
import { LockError } from '../../../shared/errors/index.js';
import { createLogger } from '../../../shared/logging/logger.js';

const log = createLogger('lock-adapter');

interface LockPayload {
  pid: number;
  createdAt: string;
}

/**
 * OpenClaw-compatible file locking adapter
 * Implements same algorithm as session-write-lock.ts:
 * - Lock file: {sessionFile}.lock with JSON payload
 * - Stale detection: 30min default
 * - Max hold: 5min watchdog
 * - Exponential backoff: 50ms × attempt, cap 1000ms
 */
export class OpenClawLockAdapter implements LockService {
  private readonly staleMs = 30 * 60 * 1000; // 30 minutes
  private readonly maxAcquireAttempts = 200; // ~10s total with backoff
  private watchedLocks = new Map<string, NodeJS.Timeout>();

  async acquire(sessionFile: string): Promise<LockHandle> {
    const lockPath = `${sessionFile}.lock`;
    const payload: LockPayload = {
      pid: process.pid,
      createdAt: new Date().toISOString(),
    };

    return this.tryAcquire(lockPath, payload, 0);
  }

  private async tryAcquire(
    lockPath: string,
    payload: LockPayload,
    attempt: number
  ): Promise<LockHandle> {
    if (attempt > this.maxAcquireAttempts) {
      throw new LockError(lockPath.replace(/\.lock$/, ''));
    }

    try {
      // Ensure directory exists
      await mkdir(dirname(lockPath), { recursive: true });

      // Try exclusive create (wx flag) - atomic operation
      const handle = await open(lockPath, 'wx', 0o666);
      
      // Write lock content
      await handle.writeFile(JSON.stringify(payload, null, 2), 'utf8');
      await handle.close();

      // Start watchdog
      this.startWatchdog(lockPath);

      return {
        release: async () => {
          this.stopWatchdog(lockPath);
          try {
            await rm(lockPath, { force: true });
          } catch {
            // Ignore cleanup errors
          }
        },
      };
    } catch (err) {
      const error = err as NodeJS.ErrnoException;

      // EEXIST = lock already held
      if (error.code === 'EEXIST') {
        // Check if stale
        if (await this.isStale(lockPath)) {
          // Remove stale lock and retry
          try {
            await rm(lockPath, { force: true });
          } catch {
            // Someone else might have removed it, continue to retry
          }
          return this.tryAcquire(lockPath, payload, attempt + 1);
        }

        // Lock held, wait with exponential backoff
        const delayMs = Math.min(1000, 50 * (attempt + 1));
        await this.sleep(delayMs);
        return this.tryAcquire(lockPath, payload, attempt + 1);
      }

      // Other errors
      throw error;
    }
  }

  async isLocked(sessionFile: string): Promise<boolean> {
    const lockPath = `${sessionFile}.lock`;
    
    try {
      await stat(lockPath);
      return true;
    } catch {
      return false;
    }
  }

  async releaseStale(maxAgeMs = this.staleMs): Promise<number> {
    // This is a utility for cleanup - normally shouldn't be needed
    // OpenClaw's own process handles stale detection
    
    // Implementation would scan session directories for stale locks
    // For now, return 0 (no stale locks found)
    return 0;
  }

  private async isStale(lockPath: string): Promise<boolean> {
    try {
      const stats = await stat(lockPath);
      const ageMs = Date.now() - stats.mtimeMs;
      
      if (ageMs > this.staleMs) {
        return true;
      }

      // Check if PID is still alive
      try {
        const content = await readFile(lockPath, 'utf8');
        const payload = JSON.parse(content) as LockPayload;
        
        // Check if process exists
        if (!this.isProcessAlive(payload.pid)) {
          return true;
        }
      } catch {
        // Can't read lock file - treat as stale
        return true;
      }

      return false;
    } catch {
      // Lock doesn't exist - not stale, just missing
      return false;
    }
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private startWatchdog(lockPath: string): void {
    // OpenClaw uses 5min max hold
    const maxHoldMs = 5 * 60 * 1000;
    
    const timeout = setTimeout(() => {
      log.warn({ lockPath }, 'lock watchdog releasing stale lock');
      void rm(lockPath, { force: true });
    }, maxHoldMs);

    this.watchedLocks.set(lockPath, timeout);
  }

  private stopWatchdog(lockPath: string): void {
    const timeout = this.watchedLocks.get(lockPath);
    if (timeout) {
      clearTimeout(timeout);
      this.watchedLocks.delete(lockPath);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
