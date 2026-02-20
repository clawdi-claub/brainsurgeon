/**
 * Smart Pruning Configuration Types
 * Runtime config persisted to .brainsurgeon/config.json
 */

export type TriggerType = 'thinking' | 'tool_result' | 'assistant' | 'user' | 'system';

export interface SmartPruningConfig {
  /** Master toggle for smart pruning */
  enabled: boolean;

  /** Which message types trigger extraction */
  trigger_types: TriggerType[];

  /** Keep this many recent messages in context (extract older ones) */
  keep_recent: number;

  /** Only extract values longer than this (characters) */
  min_value_length: number;

  /** Scan interval in seconds (default: 30) */
  scan_interval_seconds: number;

  /** Cron expression for auto-run (legacy, prefer scan_interval) */
  auto_cron: string;

  /** ISO timestamp of last successful run */
  last_run_at: string | null;

  /** Retention duration string: "24h", "1d", "7d", "30d", etc */
  retention: string;

  /** Cron for retention cleanup (default: every 6 hours) */
  retention_cron: string;

  /** ISO timestamp of last retention run */
  last_retention_run_at: string | null;

  /** Debug: keep restore_remote tool calls in session? */
  keep_restore_remote_calls: boolean;
}

export const DEFAULT_CONFIG: SmartPruningConfig = {
  enabled: false,
  trigger_types: ['thinking', 'tool_result'],
  keep_recent: 3,
  min_value_length: 500,
  scan_interval_seconds: 30,
  auto_cron: '*/2 * * * *',
  last_run_at: null,
  retention: '24h',
  retention_cron: '0 */6 * * *',
  last_retention_run_at: null,
  keep_restore_remote_calls: false,
};

/** Valid trigger types for validation */
export const VALID_TRIGGER_TYPES: TriggerType[] = [
  'thinking', 'tool_result', 'assistant', 'user', 'system'
];

/** Config response for API (omits internal timestamps) */
export interface ConfigResponse {
  enabled: boolean;
  trigger_types: TriggerType[];
  keep_recent: number;
  min_value_length: number;
  scan_interval_seconds: number;
  auto_cron: string;
  retention: string;
  retention_cron: string;
  keep_restore_remote_calls: boolean;
}

/** Config update request */
export interface ConfigUpdateRequest {
  enabled?: boolean;
  trigger_types?: TriggerType[];
  keep_recent?: number;
  min_value_length?: number;
  scan_interval_seconds?: number;
  auto_cron?: string;
  retention?: string;
  retention_cron?: string;
  keep_restore_remote_calls?: boolean;
}
