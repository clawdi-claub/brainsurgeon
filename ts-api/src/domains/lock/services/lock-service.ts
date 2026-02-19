// Lock service interface - abstraction for coordination

export interface LockHandle {
  release(): Promise<void>;
}

export interface LockService {
  /**
   * Acquire lock for session file
   * @param sessionFile Path to session file
   * @returns Lock handle - MUST call release()
   * @throws LockError if acquisition fails
   */
  acquire(sessionFile: string): Promise<LockHandle>;
  
  /**
   * Check if session is currently locked
   * @param sessionFile Path to session file
   */
  isLocked(sessionFile: string): Promise<boolean>;
  
  /**
   * Force release stale locks (cleanup utility)
   * @param maxAgeMs Maximum age in milliseconds (default 30min)
   */
  releaseStale(maxAgeMs?: number): Promise<number>;
}
