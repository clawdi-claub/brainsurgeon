/**
 * Pruning Executor Stub
 * Placeholder implementation - full logic in SP-05 and SP-07
 */

import type { SmartPruningConfig } from '../../config/model/config.js';
import type { PruningExecutor } from '../cron/cron-service.js';

export class SmartPruningExecutor implements PruningExecutor {
  private agentsDir: string;

  constructor(agentsDir: string) {
    this.agentsDir = agentsDir;
  }

  /**
   * Run smart pruning across all sessions
   * STUB: Logs what would happen, returns mock results
   */
  async runSmartPruning(config: SmartPruningConfig): Promise<{
    sessionsScanned: number;
    entriesExtracted: number;
    bytesSaved: number;
  }> {
    console.log('[PruningExecutor] STUB: Would run smart pruning with config:', {
      enabled: config.enabled,
      trigger_types: config.trigger_types,
      age_threshold_hours: config.age_threshold_hours,
    });

    // TODO SP-05: Implement actual extraction logic
    // 1. Scan all sessions
    // 2. Detect matching entries
    // 3. Extract keys to extracted/{session}/{entry}.jsonl
    // 4. Update main session with placeholders

    return {
      sessionsScanned: 0,
      entriesExtracted: 0,
      bytesSaved: 0,
    };
  }

  /**
   * Run retention cleanup
   * STUB: Logs what would happen, returns mock results
   */
  async runRetentionCleanup(retention: string): Promise<{
    filesDeleted: number;
    bytesReclaimed: number;
  }> {
    console.log(`[PruningExecutor] STUB: Would cleanup files older than ${retention}`);

    // TODO SP-07: Implement actual retention cleanup
    // 1. Parse retention duration
    // 2. Find extracted files older than retention
    // 3. Delete files and log
    // 4. Update sessions to mark orphaned placeholders

    return {
      filesDeleted: 0,
      bytesReclaimed: 0,
    };
  }
}
