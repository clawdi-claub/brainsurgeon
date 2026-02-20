/**
 * Restore Service
 * Handles restore_remote tool calls and remote_restore redaction
 * 
 * When agent calls restore_remote:
 * 1. Read extracted data from storage
 * 2. Restore values to the entry in the session
 * 3. Redact the restore_remote call to remote_restore placeholder
 * 4. Protect restored entry from re-extraction for keep_recent messages
 */

import type { SessionRepository } from '../../session/repository/session-repository.js';
import type { ExtractionStorage } from '../extraction/extraction-storage.js';
import { restoreExtractedContent, hasExtractedPlaceholders } from '../extraction/key-level-extraction.js';
import type { SessionEntry } from '../trigger/trigger-detector.js';
import { createLogger } from '../../../shared/logging/logger.js';

const log = createLogger('restore-service');

export interface RestoreResult {
  success: boolean;
  error?: string;
  entryId: string;
  keysRestored: string[];
  sizesBytes: Record<string, number>;
  totalSize: number;
  redacted: boolean;
  /** If entry was previously restored, shows when */
  previousRestoredAt?: string;
  /** Suggestion for agent if re-restoring */
  suggestion?: string;
}

export interface RestoreRequest {
  agentId: string;
  sessionId: string;
  entryId: string;
  keys?: string[]; // If not provided, restore all available keys
}

export class RestoreService {
  constructor(
    private storage: ExtractionStorage,
    private sessionRepo: SessionRepository,
  ) {}

  /**
   * Restore extracted content for an entry
   * 
   * @param request - Restore request with agent, session, entry IDs
   * @param keepRestoreCalls - If true, don't redact the restore_remote call
   * @returns RestoreResult with details of what was restored
   */
  async restoreEntry(
    request: RestoreRequest,
    keepRestoreCalls: boolean = false,
  ): Promise<RestoreResult> {
    const { agentId, sessionId, entryId, keys } = request;

    try {
      // Load the session
      const session = await this.sessionRepo.load(agentId, sessionId);

      // Find the entry with [[extracted]] placeholders (OpenClaw uses 'id', we check both)
      const entryIndex = session.entries.findIndex(
        (e: SessionEntry) => (e.__id === entryId || e.id === entryId) && hasExtractedPlaceholders(e)
      );

      if (entryIndex === -1) {
        // Check if entry exists but isn't extracted
        const entryExists = session.entries.findIndex((e: SessionEntry) => e.__id === entryId || e.id === entryId);
        if (entryExists !== -1) {
          const existingEntry = session.entries[entryExists];
          // Check if it was previously restored (has _restored timestamp)
          if (existingEntry._restored) {
            return {
              success: false,
              error: 'Entry was previously restored but content is not currently extracted. If you need to keep this content long-term, consider setting _extractable: false.',
              entryId,
              keysRestored: [],
              sizesBytes: {} as Record<string, number>,
              totalSize: 0,
              redacted: false,
              previousRestoredAt: existingEntry._restored as string,
              suggestion: 'Set _extractable: false on this entry to prevent future extraction.',
            };
          }
          return {
            success: false,
            error: 'Entry exists but has no extracted content',
            entryId,
            keysRestored: [],
            sizesBytes: {} as Record<string, number>,
            totalSize: 0,
            redacted: false,
          };
        }
        return {
          success: false,
          error: 'Entry not found in session',
          entryId,
          keysRestored: [],
          sizesBytes: {} as Record<string, number>,
          totalSize: 0,
          redacted: false,
        };
      }

      // Get the current entry (should have [[extracted]] placeholders)
      const currentEntry = session.entries[entryIndex];

      // Check if this is a re-restore (entry already has _restored timestamp)
      const isReRestore = !!currentEntry._restored;
      const previousRestoredAt = currentEntry._restored;

      // Load extracted data from storage
      const extractedData = await this.storage.read(agentId, sessionId, entryId);
      if (!extractedData) {
        return {
          success: false,
          error: 'Extracted data not found in storage',
          entryId,
          keysRestored: [],
          sizesBytes: {} as Record<string, number>,
          totalSize: 0,
          redacted: false,
        };
      }

      // Restore the content
      const restoredEntry = restoreExtractedContent(currentEntry, extractedData);

      // Calculate which keys were restored and their sizes
      const { __meta, ...contentData } = extractedData;
      const keysRestored: string[] = [];
      const sizesBytes: Record<string, number> = {};
      let totalSize = 0;

      // Check for [[extracted-${entryId}]] placeholders
      const expectedPlaceholder = `[[extracted-${entryId}]]`;

      for (const key of Object.keys(contentData)) {
        const entryValue = currentEntry[key];
        // Check for both old [[extracted]] and new [[extracted-${entryId}]] formats
        if (entryValue === '[[extracted]]' || entryValue === expectedPlaceholder ||
            (typeof entryValue === 'string' && entryValue.startsWith('[[extracted-'))) {
          keysRestored.push(key);
          const size = Buffer.byteLength(JSON.stringify(contentData[key]), 'utf8');
          sizesBytes[key] = size;
          totalSize += size;
        }
      }

      // Mark the entry as restored with timestamp
      // _restored persists even if re-extracted later, used for:
      // 1. Time-based re-extraction protection (keep_after_restore_seconds)
      // 2. Detecting re-restores and guiding agents
      // Spec: "_restored key is not removed when the message is extracted again"
      restoredEntry._restored = new Date().toISOString();

      // Update the session entry
      session.entries[entryIndex] = restoredEntry;

      // Save the session
      await this.sessionRepo.save(agentId, sessionId, session);

      log.debug({
        agentId,
        sessionId,
        entryId,
        keysRestored,
        sizesBytes,
        totalSize,
        isReRestore,
      }, 'restored extracted entry');

      // Build result with optional guidance for re-restores
      const result: RestoreResult = {
        success: true,
        entryId,
        keysRestored,
        sizesBytes,
        totalSize,
        redacted: false, // Caller handles redaction separately
      };

      if (isReRestore && previousRestoredAt) {
        result.previousRestoredAt = previousRestoredAt as string;
        result.suggestion = 'This entry was previously restored. If you need to keep this content long-term, consider setting _extractable: false.';
      }

      return result;

    } catch (err: any) {
      log.error({
        agentId,
        sessionId,
        entryId,
        err: err.message,
      }, 'error restoring entry');

      return {
        success: false,
        error: err.message,
        entryId,
        keysRestored: [],
        sizesBytes: {} as Record<string, number>,
        totalSize: 0,
        redacted: false,
      };
    }
  }

  /**
   * Redact a restore_remote tool call by replacing it with remote_restore placeholder
   * 
   * @param agentId - Agent ID
   * @param sessionId - Session ID
   * @param toolCallEntryId - The entry ID of the restore_remote tool call
   * @returns true if redaction was successful
   */
  async redactRestoreCall(
    agentId: string,
    sessionId: string,
    toolCallEntryId: string,
  ): Promise<boolean> {
    try {
      const session = await this.sessionRepo.load(agentId, sessionId);

      const entryIndex = session.entries.findIndex(
        (e: SessionEntry) => e.__id === toolCallEntryId || e.id === toolCallEntryId
      );

      if (entryIndex === -1) {
        log.warn({ agentId, sessionId, toolCallEntryId }, 'restore_remote call not found for redaction');
        return false;
      }

      const entry = session.entries[entryIndex];

      // Check if this is a restore_remote tool call
      if (entry.type !== 'tool_call' && entry.customType !== 'tool_call') {
        return false;
      }

      // Type assertion needed because SessionEntry has flexible structure
      const entryAny = entry as Record<string, any>;
      const toolName = entryAny.name || entryAny.message?.name || entryAny.tool?.name;
      if (toolName !== 'restore_remote') {
        return false;
      }

      // Redact by replacing the tool call
      const redactedEntry: SessionEntry = {
        ...entry,
        name: 'remote_restore',
        arguments: null,
        tool: entryAny.tool ? { ...entryAny.tool, name: 'remote_restore', arguments: null } : undefined,
        _redacted_from: 'restore_remote',
      };

      // Also redact in message if present
      if (entryAny.message) {
        (redactedEntry as Record<string, any>).message = {
          ...entryAny.message,
          name: 'remote_restore',
          arguments: null,
        };
      }

      session.entries[entryIndex] = redactedEntry;
      await this.sessionRepo.save(agentId, sessionId, session);

      log.debug({
        agentId,
        sessionId,
        entryId: toolCallEntryId,
      }, 'redacted restore_remote call to remote_restore');

      return true;

    } catch (err: any) {
      log.warn({
        agentId,
        sessionId,
        entryId: toolCallEntryId,
        err: err.message,
      }, 'error redacting restore_remote call');
      return false;
    }
  }
}
