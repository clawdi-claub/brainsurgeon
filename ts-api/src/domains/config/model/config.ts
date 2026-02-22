/**
 * Smart Pruning Configuration Types
 * Runtime config persisted to .brainsurgeon/config.json
 */

export type TriggerType = 'thinking' | 'tool_result' | 'assistant' | 'user' | 'system' | 'message' | 'custom' | 'tool_use' | string;

/**
 * Granular trigger rule for extraction
 * Allows per-type configuration with role filtering and custom matchers
 */
export interface TriggerRule {
  /** Required: entry type to match (e.g., 'message', 'thinking', 'tool_result') */
  type: string;

  /** Optional: minimum content length to trigger extraction (characters). Default: 500 */
  min_length?: number;

  /** Optional: preserve first N chars in placeholder. Default: 0 (no keep) */
  keep_chars?: number;

  /** Optional: role to match - 'user', 'agent', '*' (any), or pipe-delimited: 'user|agent'. Default: '*' */
  role?: string;

  /** Optional: keep N most recent entries of this type from extraction. Default: uses global keep_recent */
  keep_recent?: number;

  /** Generic key:value matchers (e.g., toolName: 'exec|curl') */
  [key: string]: string | number | undefined;
}

export interface SmartPruningConfig {
  /** Master toggle for smart pruning */
  enabled: boolean;

  /** Legacy: flat trigger types array. Migrated to trigger_rules if present. */
  trigger_types?: TriggerType[];

  /** New: granular trigger rules with per-type config */
  trigger_rules?: TriggerRule[];

  /** Global default: keep this many recent messages. Override by per-rule keep_recent. */
  keep_recent: number;

  /** Global default: minimum content length. Override by per-rule min_length. */
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

  /** How long to protect restored entries from re-extraction (seconds). Default: 600 (10 min) */
  keep_after_restore_seconds: number;
}

export const DEFAULT_CONFIG: SmartPruningConfig = {
  enabled: false,
  trigger_rules: [
    { type: 'thinking', min_length: 500, keep_recent: 3 },
    { type: 'tool_result', min_length: 500, keep_recent: 3 },
  ],
  keep_recent: 3,
  min_value_length: 500,
  scan_interval_seconds: 30,
  auto_cron: '*/2 * * * *',
  last_run_at: null,
  retention: '24h',
  retention_cron: '0 */6 * * *',
  last_retention_run_at: null,
  keep_restore_remote_calls: false,
  keep_after_restore_seconds: 600, // 10 minutes default
};

/** Valid trigger types for validation */
export const VALID_TRIGGER_TYPES: TriggerType[] = [
  'thinking', 'tool_result', 'assistant', 'user', 'system'
];

/** Config response for API (omits internal timestamps) */
export interface ConfigResponse {
  enabled: boolean;
  trigger_rules?: TriggerRule[];
  trigger_types?: TriggerType[]; // Legacy, for backward compatibility
  keep_recent: number;
  min_value_length: number;
  scan_interval_seconds: number;
  auto_cron: string;
  retention: string;
  retention_cron: string;
  keep_restore_remote_calls: boolean;
  keep_after_restore_seconds: number;
}

/** Config update request */
export interface ConfigUpdateRequest {
  enabled?: boolean;
  trigger_rules?: TriggerRule[];
  trigger_types?: TriggerType[]; // Legacy, will be migrated to trigger_rules
  keep_recent?: number;
  min_value_length?: number;
  scan_interval_seconds?: number;
  auto_cron?: string;
  retention?: string;
  retention_cron?: string;
  keep_restore_remote_calls?: boolean;
  keep_after_restore_seconds?: number;
}

/** Helper to migrate old trigger_types to trigger_rules */
export function migrateTriggerTypesToRules(
  triggerTypes: TriggerType[],
  globalKeepRecent: number = 3,
  globalMinLength: number = 500
): TriggerRule[] {
  return triggerTypes.map(type => ({
    type,
    min_length: globalMinLength,
    keep_recent: globalKeepRecent,
  }));
}

/** Helper to build effective rules list - merges defaults with provided rules */
export function buildEffectiveRules(
  rules: TriggerRule[] | undefined,
  globalKeepRecent: number,
  globalMinLength: number
): TriggerRule[] {
  if (!rules || rules.length === 0) {
    return DEFAULT_CONFIG.trigger_rules!;
  }

  return rules.map(rule => ({
    role: '*',
    ...rule,
    // Apply defaults for missing numeric fields
    min_length: rule.min_length ?? globalMinLength,
    keep_recent: rule.keep_recent ?? globalKeepRecent,
    keep_chars: rule.keep_chars ?? 0,
  }));
}
