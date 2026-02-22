/**
 * Smart Pruning Trigger Logic
 * Detects entries matching configured trigger_rules with per-type config.
 *
 * CORE RULE: For each rule, keep the most recent `keep_recent` matching
 * entries in context. Extract everything older that meets criteria.
 *
 * Rules are evaluated in declaration order; the first fully matching rule wins.
 */

import type { TriggerType, TriggerRule } from '../../../domains/config/model/config.js';

/**
 * Session entry from OpenClaw JSONL
 */
export interface SessionEntry {
  /** Entry ID (OpenClaw uses 'id', BrainSurgeon uses '__id' internally) */
  __id?: string;
  id?: string;
  type?: string;
  customType?: string;
  message?: {
    role?: string;
    created_at?: string;
    content?: string;
  };
  role?: string;
  timestamp?: string | number;
  __ts?: number;
  time?: number;
  content?: string;
  text?: string;
  output?: string;
  result?: any;
  data?: any;
  /** Per-message extraction override */
  _extractable?: boolean | number;
  /** ISO timestamp when entry was restored from extraction (used for re-extraction protection) */
  _restored?: string;
  [key: string]: any;
}

/**
 * Result of trigger detection
 */
export interface TriggerMatch {
  /** Entry matched a trigger rule */
  matched: boolean;
  /** Which trigger type matched */
  triggerType: TriggerType | null;
  /** The full rule that matched (carries keep_chars, etc.) */
  matchedRule?: TriggerRule;
  /** Entry has __id field (can be extracted) */
  hasId: boolean;
  /** Entry position from end (0 = most recent) */
  positionFromEnd: number;
  /** Entry meets keep_recent threshold (position >= keep_recent) */
  meetsPositionThreshold: boolean;
  /** Would be extracted (all conditions met) */
  shouldExtract: boolean;
  /** Reason for not extracting (if shouldExtract is false) */
  skipReason?: string;
}

/**
 * Configuration for trigger detection (rule-based)
 */
export interface TriggerConfig {
  enabled: boolean;
  /** Granular trigger rules with per-type config */
  trigger_rules: TriggerRule[];
  /** Global default: keep N most recent entries (fallback when rule omits keep_recent) */
  keep_recent: number;
  /** Global default: minimum content length (fallback when rule omits min_length) */
  min_value_length: number;
  /** How long to protect restored entries from re-extraction (seconds) */
  keep_after_restore_seconds: number;
}

// ─── helpers ────────────────────────────────────────────────────────────

/** Resolve effective keep_recent for a rule (rule-level overrides global). */
function effectiveKeepRecent(rule: TriggerRule, globalKeepRecent: number): number {
  return rule.keep_recent ?? globalKeepRecent;
}

/** Resolve effective min_length for a rule (rule-level overrides global). */
function effectiveMinLength(rule: TriggerRule, globalMinLength: number): number {
  return rule.min_length ?? globalMinLength;
}

// ─── public API ─────────────────────────────────────────────────────────

/**
 * Detect if an entry matches smart prune triggers.
 *
 * Preconditions (all must pass):
 * 1. Smart pruning enabled
 * 2. Entry has __id or id field (required for extraction)
 * 3. Entry doesn't already have [[extracted]] placeholders
 * 4. _extractable override check (force / prevent / default)
 * 5. Entry not recently restored (time-based re-extraction protection)
 * 6. A trigger rule matches (type + role + generic matchers)
 * 7. Entry position >= rule's keep_recent (old enough to extract)
 * 8. Entry has content values >= rule's min_length (worth extracting)
 */
export function detectTrigger(
  entry: SessionEntry,
  config: TriggerConfig,
  positionFromEnd: number,
): TriggerMatch {
  const noMatch = (skipReason: string, extras?: Partial<TriggerMatch>): TriggerMatch => ({
    matched: false,
    triggerType: null,
    hasId: false,
    positionFromEnd,
    meetsPositionThreshold: false,
    shouldExtract: false,
    skipReason,
    ...extras,
  });

  // 1 — enabled?
  if (!config.enabled) {
    return noMatch('smart_pruning_disabled');
  }

  // 2 — has ID?
  const entryId = entry.__id || entry.id;
  if (!entryId) {
    return noMatch('no_entry_id');
  }

  // 3 — already extracted?
  if (hasExtractedPlaceholders(entry)) {
    return noMatch('already_extracted', { hasId: true });
  }

  // 4 — _extractable override
  const override = getExtractableOverride(entry, positionFromEnd, config.keep_recent);

  if (override === 'force') {
    return {
      matched: true,
      triggerType: detectEntryType(entry) ?? 'assistant',
      hasId: true,
      positionFromEnd,
      meetsPositionThreshold: true,
      shouldExtract: true,
    };
  }

  if (override === 'prevent') {
    return noMatch('_extractable_false', { hasId: true });
  }

  // 5 — re-extraction protection
  if (entry._restored) {
    const restoredAt = new Date(entry._restored).getTime();
    const protectedUntil = restoredAt + config.keep_after_restore_seconds * 1000;
    if (Date.now() < protectedUntil) {
      const remaining = Math.ceil((protectedUntil - Date.now()) / 1000);
      return noMatch(`recently_restored (${remaining}s remaining)`, { hasId: true });
    }
  }

  // 6-8 — rule matching
  const detectedType = detectEntryType(entry);
  const entryRole = resolveEntryRole(entry);

  for (const rule of config.trigger_rules) {
    // 6a — type match
    if (!matchesType(rule.type, detectedType)) continue;

    // 6b — role match (default '*')
    if (!matchesPipe(rule.role ?? '*', entryRole)) continue;

    // 6c — generic key:value matchers
    if (!matchesGenericKeys(rule, entry)) continue;

    // At this point the rule structurally matches.
    const ruleKeepRecent = effectiveKeepRecent(rule, config.keep_recent);
    const ruleMinLength = effectiveMinLength(rule, config.min_value_length);

    // 7 — keep_recent check
    if (positionFromEnd < ruleKeepRecent) {
      return {
        matched: true,
        triggerType: rule.type,
        matchedRule: rule,
        hasId: true,
        positionFromEnd,
        meetsPositionThreshold: false,
        shouldExtract: false,
        skipReason: 'too_recent',
      };
    }

    // 8 — value size check
    const sizes = checkValueSizes(entry, ruleMinLength);
    if (!sizes.hasLargeValues) {
      return {
        matched: true,
        triggerType: rule.type,
        matchedRule: rule,
        hasId: true,
        positionFromEnd,
        meetsPositionThreshold: true,
        shouldExtract: false,
        skipReason: 'values_too_small',
      };
    }

    // All checks pass — extract
    return {
      matched: true,
      triggerType: rule.type,
      matchedRule: rule,
      hasId: true,
      positionFromEnd,
      meetsPositionThreshold: true,
      shouldExtract: true,
    };
  }

  // No rule matched
  return noMatch('type_not_matched', { hasId: true });
}

// ─── matching helpers ──────────────────────────────────────────────────

/**
 * Match a rule type against detected entry type.
 * Handles wildcard '*' and pipe-delimited values (e.g., "thinking|tool_result").
 */
function matchesType(ruleType: string, detectedType: string | null): boolean {
  if (ruleType === '*') return true;
  if (!detectedType) return false;
  return matchesPipe(ruleType, detectedType);
}

/**
 * Match a pipe-delimited pattern against a value.
 * e.g., pattern "user|agent" matches "user" or "agent".
 * Wildcard '*' matches anything.
 */
function matchesPipe(pattern: string, value: string | null | undefined): boolean {
  if (pattern === '*') return true;
  if (!value) return false;
  const options = pattern.split('|').map(s => s.trim().toLowerCase());
  return options.includes(value.toLowerCase());
}

/**
 * Match generic key:value matchers from a rule against an entry.
 * Reserved keys (type, min_length, keep_chars, role, keep_recent) are skipped.
 * All generic matchers must match (AND logic); each value supports pipe OR.
 */
const RESERVED_RULE_KEYS = new Set(['type', 'min_length', 'keep_chars', 'role', 'keep_recent']);

function matchesGenericKeys(rule: TriggerRule, entry: SessionEntry): boolean {
  for (const key of Object.keys(rule)) {
    if (RESERVED_RULE_KEYS.has(key)) continue;

    const ruleValue = rule[key];
    if (ruleValue === undefined) continue;

    const entryValue = entry[key];

    if (typeof ruleValue === 'string') {
      if (!matchesPipe(ruleValue, entryValue != null ? String(entryValue) : null)) {
        return false;
      }
    } else if (typeof ruleValue === 'number') {
      if (entryValue !== ruleValue) return false;
    }
  }
  return true;
}

// ─── _extractable override ──────────────────────────────────────────────

function getExtractableOverride(
  entry: SessionEntry,
  positionFromEnd: number,
  globalKeepRecent: number,
): 'force' | 'prevent' | 'default' {
  const extractable = entry._extractable;

  if (extractable === true) return 'force';
  if (extractable === false) return 'prevent';

  if (typeof extractable === 'number') {
    // Keep for this many messages (override global keep_recent)
    return positionFromEnd < extractable ? 'prevent' : 'default';
  }

  return 'default';
}

// ─── value size checking ────────────────────────────────────────────────

/**
 * Check if entry has content values larger than minValueLength.
 * Returns which keys are large enough to extract.
 */
export function checkValueSizes(
  entry: SessionEntry,
  minValueLength: number,
): {
  hasLargeValues: boolean;
  largeKeys: { key: string; length: number }[];
  totalSize: number;
} {
  const largeKeys: { key: string; length: number }[] = [];
  let totalSize = 0;

  const keysToCheck = ['content', 'text', 'output', 'result', 'data', 'thinking', 'message'];

  for (const key of keysToCheck) {
    const value = entry[key];
    if (value == null) continue;

    const length = typeof value === 'string' ? value.length : JSON.stringify(value).length;

    if (length >= minValueLength) {
      largeKeys.push({ key, length });
      totalSize += length;
    }
  }

  // Also check nested message.content
  if (entry.message?.content && typeof entry.message.content === 'string') {
    const length = entry.message.content.length;
    if (length >= minValueLength && !largeKeys.find(k => k.key === 'message.content')) {
      largeKeys.push({ key: 'message.content', length });
      totalSize += length;
    }
  }

  return { hasLargeValues: largeKeys.length > 0, largeKeys, totalSize };
}

// ─── type detection ─────────────────────────────────────────────────────

/**
 * Detect the semantic type of a session entry.
 * Priority: customType → type → message.role → role → infer from content.
 */
function detectEntryType(entry: SessionEntry): TriggerType | null {
  if (entry.customType) {
    const t = normalizeType(entry.customType);
    if (t) return t;
  }
  if (entry.type) {
    const t = mapTypeToTrigger(entry.type);
    if (t) return t;
  }
  if (entry.message?.role) {
    const t = normalizeType(entry.message.role);
    if (t) return t;
  }
  if (entry.role) {
    const t = normalizeType(entry.role);
    if (t) return t;
  }
  return inferTypeFromContent(entry);
}

function mapTypeToTrigger(type: string): TriggerType | null {
  switch (type.toLowerCase()) {
    case 'tool_result': return 'tool_result';
    case 'tool_call': return 'assistant';
    default: return null;
  }
}

function normalizeType(type: string): TriggerType | null {
  switch (type.toLowerCase()) {
    case 'thinking': return 'thinking';
    case 'tool_result': return 'tool_result';
    case 'assistant': case 'ai': return 'assistant';
    case 'user': case 'human': return 'user';
    case 'system': return 'system';
    default: return null;
  }
}

function inferTypeFromContent(entry: SessionEntry): TriggerType | null {
  if (entry.thinking || entry.data?.thinking) return 'thinking';
  if (entry.tool_result || entry.result || entry.data?.result) return 'tool_result';
  return null;
}

/**
 * Resolve the role of an entry for rule matching.
 * Returns lowercase role string or null.
 */
function resolveEntryRole(entry: SessionEntry): string | null {
  if (entry.message?.role) return entry.message.role.toLowerCase();
  if (entry.role) return entry.role.toLowerCase();
  // Infer from type for common patterns
  if (entry.customType === 'thinking') return 'agent';
  if (entry.type === 'tool_result') return null; // tool results have no role
  return null;
}

/**
 * Check if an entry has any [[extracted-${entryId}]] placeholders.
 * Used to prevent double-extraction.
 */
export function hasExtractedPlaceholders(entry: SessionEntry): boolean {
  return JSON.stringify(entry).includes('[[extracted-');
}
