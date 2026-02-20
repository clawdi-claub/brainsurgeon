/**
 * Smart Pruning Executor
 * Scans sessions, detects matching entries, extracts to separate files,
 * and updates main session with [[extracted]] placeholders.
 */

import type { SmartPruningConfig } from '../../config/model/config.js';
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

    log.info({
      trigger_types: config.trigger_types,
      age_threshold_hours: config.age_threshold_hours,
    }, 'starting smart pruning run');

    const sessions = await this.sessionRepo.list();
    let totalExtracted = 0;
    let totalBytes = 0;

    for (const item of sessions) {
      try {
        const session = await this.sessionRepo.load(item.agentId, item.id);
        let modified = false;

        for (let i = 0; i < session.entries.length; i++) {
          const entry = session.entries[i];

          // Skip entries without __id (can't be extracted)
          if (!entry.__id) continue;

          // Skip already-extracted entries
          if (hasExtractedPlaceholders(entry)) continue;

          const match = detectTrigger(entry, {
            enabled: config.enabled,
            trigger_types: config.trigger_types,
            age_threshold_hours: config.age_threshold_hours,
          }, i);

          if (!match.shouldExtract || !match.triggerType) continue;

          // Extract keys
          const result = extractEntryKeys(entry, match.triggerType);
          if (!result.success || result.extractedKeys.length === 0) continue;

          // Store extracted data
          const { sizeBytes } = await this.storage.store(
            item.agentId,
            item.id,
            entry.__id as string,
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
            entryId: entry.__id,
            triggerType: match.triggerType,
            keys: result.extractedKeys,
            sizeBytes,
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
