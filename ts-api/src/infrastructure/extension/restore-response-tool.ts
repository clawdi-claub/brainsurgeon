// restore_response tool implementation
// Rehydrates externalized tool results when session needs them

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionRepository } from '../../domains/session/repository/session-repository.js';
import type { LockService } from '../../domains/lock/services/lock-service.js';
import { NotFoundError } from '../../shared/errors/index.js';

interface ExternalToolResult {
  toolCallId: string;
  content: unknown[];
  toolName?: string;
}

/**
 * Handles restore_response tool calls
 * Replaces stub entry with full externalized content
 */
export class RestoreResponseTool {
  constructor(
    private sessionRepo: SessionRepository,
    private lockService: LockService,
    private sessionsDir: string
  ) {}

  async execute(agentId: string, sessionId: string, toolCallId: string): Promise<{ success: boolean; restored?: string }> {
    const externalFile = join(
      this.sessionsDir,
      agentId,
      'external',
      `${toolCallId}.json`
    );

    // Check if external file exists
    try {
      await import('node:fs/promises').then(m => m.access(externalFile));
    } catch {
      throw new NotFoundError('Externalized response', toolCallId);
    }

    // Read external content
    const content = await readFile(externalFile, 'utf8');
    const externalData = JSON.parse(content) as ExternalToolResult;

    // Acquire session lock
    const sessionFile = join(this.sessionsDir, agentId, `${sessionId}.jsonl`);
    const lock = await this.lockService.acquire(sessionFile);

    try {
      const session = await this.sessionRepo.load(agentId, sessionId);

      // Find the stub entry
      const entryIndex = session.entries.findIndex(
        e => e.type === 'tool_result' && e.toolCallId === toolCallId
      );

      if (entryIndex === -1) {
        throw new NotFoundError('Tool result entry', toolCallId);
      }

      // Replace stub with full content
      const entry = session.entries[entryIndex];
      if (entry && entry.type === 'tool_result') {
        entry.content = externalData.content as any;
        entry.toolName = externalData.toolName;
      }

      // Save session
      await this.sessionRepo.save(agentId, sessionId, session);

      // Mark external file as consumed (but don't delete immediately - keep for safety)
      await writeFile(
        `${externalFile}.consumed`,
        JSON.stringify({ consumedAt: Date.now() }),
        'utf8'
      );

      return { success: true, restored: toolCallId };
    } finally {
      await lock.release();
    }
  }
}
