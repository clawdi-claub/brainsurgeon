/**
 * Smart Pruning Executor
 * Scans sessions, detects matching entries, extracts to separate files,
 * and updates main session with [[extracted]] placeholders.
 */

import type { SmartPruningConfig } from '../../config/model/config.js';
import { buildEffectiveRules } from '../../config/model/config.js';
import type { PruningExecutor } from '../cron/cron-service.js';
import type { SessionRepository } from '../../session/repository/session-repository.js';
import { ExtractionStorage } from '../extraction/extraction-storage.js';
import { extractEntryKeys, hasExtractedPlaceholders } from '../extraction/key-level-extraction.js';
import { detectTrigger } from '../trigger/trigger-detector.js';
import { parseDurationMs } from '../../../shared/utils/duration-parser.js';
import { createLogger } from '../../../shared/logging/logger.js';

const log = createLogger('pruning-executor');

export class SmartPruningExecutor implements PruningExecutor {
  private storage: ExtractionStorage;
  private sessionRepo: SessionRepository;

  constructor(agentsDir: string, sessionRepo: SessionRepository) {
    this.storage = new ExtractionStorage({ agentsDir });
    this.sessionRepo = sessionRepo;
  }

  /**
   * Run smart pruning across all sessions.
   * For each session: detect trigger-matching entries → extract → save placeholders.
   * Uses position-based logic: keep most recent `keep_recent` messages, extract older ones.
   */
  async runSmartPruning(config: SmartPruningConfig): Promise<{
    sessionsScanned: number;
    entriesExtracted: number;
    bytesSaved: number;
  }> {
    if (!config.enabled) {
      log.debug('smart pruning disabled, skipping');
      return { sessionsScanned: 0, entriesExtracted: 0, bytesSaved: 0 };
    }

    const effectiveRules = buildEffectiveRules(
      config.trigger_rules,
      config.keep_recent,
      config.min_value_length,
    );

    log.info({
      trigger_rules: effectiveRules.map(r => r.type),
      keep_recent: config.keep_recent,
      min_value_length: config.min_value_length,
    }, 'starting smart pruning run');

    const sessions = await this.sessionRepo.list();
    let totalExtracted = 0;
    let totalBytes = 0;

    for (const item of sessions) {
      try {
        const session = await this.sessionRepo.load(item.agentId, item.id);
        let modified = false;

        // Process entries from oldest to newest
        // Position from end: 0 = most recent, session.entries.length-1 = oldest
        for (let i = 0; i < session.entries.length; i++) {
          const entry = session.entries[i];
          const positionFromEnd = session.entries.length - 1 - i;

          // Skip entries without __id or id (can't be extracted)
          const entryId = entry.__id || entry.id;
          if (!entryId) continue;

          // Skip already-extracted entries
          if (hasExtractedPlaceholders(entry)) continue;

          const match = detectTrigger(entry, {
            enabled: config.enabled,
            trigger_rules: effectiveRules,
            keep_recent: config.keep_recent,
            min_value_length: config.min_value_length,
            keep_after_restore_seconds: config.keep_after_restore_seconds,
          }, positionFromEnd);

          if (!match.shouldExtract || !match.triggerType) continue;

          // Extract keys with keep_chars from matched rule
          const keepChars = match.matchedRule?.keep_chars ?? 0;
          const result = extractEntryKeys(entry, match.triggerType, keepChars);
          if (!result.success || result.extractedKeys.length === 0) continue;

          // Store extracted data
          const { sizeBytes } = await this.storage.store(
            item.agentId,
            item.id,
            entryId as string,
            result.extractedData,
          );

          // Replace entry with placeholder version
          session.entries[i] = result.modifiedEntry;
          modified = true;
          totalExtracted++;
          totalBytes += sizeBytes;

          log.debug({
            agentId: item.agentId,
            sessionId: item.id,
            entryId: entryId,
            triggerType: match.triggerType,
            keys: result.extractedKeys,
            sizesBytes: result.sizesBytes,
            totalSize: sizeBytes,
            positionFromEnd,
          }, 'extracted entry');
        }

        if (modified) {
          await this.sessionRepo.save(item.agentId, item.id, session);
        }
      } catch (err: any) {
        log.warn({
          agentId: item.agentId,
          sessionId: item.id,
          err: err.message,
        }, 'error processing session for pruning');
      }
    }

    log.info({
      sessionsScanned: sessions.length,
      entriesExtracted: totalExtracted,
      bytesSaved: totalBytes,
    }, 'smart pruning complete');

    return {
      sessionsScanned: sessions.length,
      entriesExtracted: totalExtracted,
      bytesSaved: totalBytes,
    };
  }

  /**
   * Run retention cleanup — delete extracted files older than retention duration.
   */
  async runRetentionCleanup(retention: string): Promise<{
    filesDeleted: number;
    bytesReclaimed: number;
  }> {
    const maxAgeMs = parseDurationMs(retention);

    log.info({ retention, maxAgeMs }, 'starting retention cleanup');

    const expired = await this.storage.findExpired(maxAgeMs);
    let bytesReclaimed = 0;

    for (const item of expired) {
      try {
        const data = await this.storage.read(item.agentId, item.sessionId, item.entryId);
        const fileSize = data ? Buffer.byteLength(JSON.stringify(data), 'utf8') : 0;

        await this.storage.delete(item.agentId, item.sessionId, item.entryId);
        bytesReclaimed += fileSize;

        log.debug({
          agentId: item.agentId,
          sessionId: item.sessionId,
          entryId: item.entryId,
          ageMs: item.ageMs,
        }, 'deleted expired extraction');
      } catch (err: any) {
        log.warn({
          filePath: item.filePath,
          err: err.message,
        }, 'error deleting expired extraction');
      }
    }

    log.info({
      filesDeleted: expired.length,
      bytesReclaimed,
    }, 'retention cleanup complete');

    return {
      filesDeleted: expired.length,
      bytesReclaimed,
    };
  }

  /** Expose storage for direct access (API endpoints, etc.) */
  get extractionStorage(): ExtractionStorage {
    return this.storage;
  }
}
