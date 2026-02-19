/**
 * Smart Pruning Trigger Logic
 * Detects entries matching configured trigger_types and age thresholds
 */

import type { TriggerType } from '../../../domains/config/model/config.js';

/**
 * Session entry from OpenClaw JSONL
 */
export interface SessionEntry {
  __id?: string;
  type?: string;
  customType?: string;
  message?: {
    role?: string;
    created_at?: string;
  };
  role?: string;
  timestamp?: string | number;
  __ts?: number;
  time?: number;
  [key: string]: any;
}

/**
 * Result of trigger detection
 */
export interface TriggerMatch {
  /** Entry matched a trigger type */
  matched: boolean;
  /** Which trigger type matched */
  triggerType: TriggerType | null;
  /** Entry has __id field (can be extracted) */
  hasId: boolean;
  /** Entry age in milliseconds */
  ageMs: number;
  /** Entry age meets threshold */
  ageMeetsThreshold: boolean;
  /** Would be extracted (all conditions met) */
  shouldExtract: boolean;
}

/**
 * Configuration for trigger detection
 */
export interface TriggerConfig {
  enabled: boolean;
  trigger_types: TriggerType[];
  age_threshold_hours: number;
}

/**
 * Detect if an entry matches smart prune triggers
 * 
 * Preconditions (all must pass):
 * 1. Smart pruning enabled
 * 2. Entry has __id field (required for extraction)
 * 3. Entry doesn't already have [[extracted]] placeholders
 * 4. Entry type matches one of trigger_types
 * 5. Entry age >= age_threshold_hours (if threshold > 0)
 * 
 * @param entry - Session entry from JSONL
 * @param config - Trigger configuration
 * @param entryIndex - Index of entry in session (for fallback age estimation)
 * @param now - Current timestamp (default: Date.now())
 * @returns TriggerMatch result
 */
export function detectTrigger(
  entry: SessionEntry,
  config: TriggerConfig,
  entryIndex: number,
  now: number = Date.now()
): TriggerMatch {
  // Check 1: Enabled
  if (!config.enabled) {
    return { 
      matched: false, 
      triggerType: null, 
      hasId: false, 
      ageMs: 0, 
      ageMeetsThreshold: false, 
      shouldExtract: false 
    };
  }

  // Check 2: Has __id field
  const hasId = !!entry.__id;

  // Check 3: Not already extracted
  const values = JSON.stringify(entry);
  const alreadyExtracted = values.includes('[[extracted]]');

  // Check 4: Type detection
  const detectedType = detectEntryType(entry);
  const matched = detectedType !== null && config.trigger_types.includes(detectedType);
  const triggerType = matched ? detectedType : null;

  // Check 5: Age threshold
  const ageMs = calculateEntryAge(entry, entryIndex, now);
  const ageMeetsThreshold = config.age_threshold_hours === 0 
    || ageMs >= (config.age_threshold_hours * 3600000);

  // All checks must pass for extraction
  const shouldExtract = matched && hasId && !alreadyExtracted && ageMeetsThreshold;

  return {
    matched,
    triggerType,
    hasId,
    ageMs,
    ageMeetsThreshold,
    shouldExtract,
  };
}

/**
 * Detect the type of a session entry
 * Priority order:
 * 1. entry.customType (for custom entries like "thinking", "model-snapshot")
 * 2. entry.type ("message", "tool_call", "tool_result")
 * 3. entry.message?.role ("assistant", "user", "system", "tool")
 * 4. entry.role (direct role field)
 * 5. Infer from content structure (fallback)
 * 
 * @param entry - Session entry
 * @returns Detected type or null if not matching any trigger type
 */
function detectEntryType(entry: SessionEntry): TriggerType | null {
  // Priority 1: customType (thinking, model-snapshot, etc.)
  if (entry.customType) {
    const type = normalizeType(entry.customType);
    if (type) return type;
  }

  // Priority 2: entry.type
  if (entry.type) {
    const type = mapTypeToTrigger(entry.type);
    if (type) return type;
  }

  // Priority 3: entry.message?.role
  if (entry.message?.role) {
    const type = normalizeType(entry.message.role);
    if (type) return type;
  }

  // Priority 4: entry.role (direct)
  if (entry.role) {
    const type = normalizeType(entry.role);
    if (type) return type;
  }

  // Priority 5: Infer from content
  return inferTypeFromContent(entry);
}

/**
 * Map entry.type to trigger type
 */
function mapTypeToTrigger(type: string): TriggerType | null {
  switch (type.toLowerCase()) {
    case 'tool_result':
      return 'tool_result';
    case 'tool_call':
      // Tool calls typically contain assistant's tool requests
      return 'assistant';
    case 'message':
      // Need to check role in message object
      return null;
    default:
      return null;
  }
}

/**
 * Normalize type string to TriggerType
 */
function normalizeType(type: string): TriggerType | null {
  const normalized = type.toLowerCase();
  switch (normalized) {
    case 'thinking':
      return 'thinking';
    case 'tool_result':
      return 'tool_result';
    case 'assistant':
    case 'ai':
      return 'assistant';
    case 'user':
    case 'human':
      return 'user';
    case 'system':
      return 'system';
    default:
      return null;
  }
}

/**
 * Infer type from entry content structure (fallback)
 */
function inferTypeFromContent(entry: SessionEntry): TriggerType | null {
  // Check for thinking content
  if (entry.thinking || entry.data?.thinking || entry.content?.thinking) {
    return 'thinking';
  }
  
  // Check for tool result patterns
  if (entry.tool_result || entry.result || entry.data?.result) {
    return 'tool_result';
  }

  return null;
}

/**
 * Calculate entry age in milliseconds
 * Priority order for timestamp sources:
 * 1. entry.timestamp (ISO string or milliseconds)
 * 2. entry.__ts (OpenClaw internal timestamp)
 * 3. entry.message?.created_at
 * 4. entry.time (milliseconds)
 * 5. Fallback: entryIndex * 60 seconds (estimated)
 * 
 * @param entry - Session entry
 * @param entryIndex - Index in session (for fallback)
 * @param now - Current timestamp
 * @returns Age in milliseconds
 */
function calculateEntryAge(
  entry: SessionEntry, 
  entryIndex: number, 
  now: number
): number {
  let entryTime: number | null = null;

  // Priority 1: entry.timestamp
  if (entry.timestamp !== undefined) {
    if (typeof entry.timestamp === 'string') {
      entryTime = new Date(entry.timestamp).getTime();
    } else if (typeof entry.timestamp === 'number') {
      entryTime = entry.timestamp;
    }
  }

  // Priority 2: entry.__ts
  if (entryTime === null && entry.__ts !== undefined) {
    entryTime = entry.__ts;
  }

  // Priority 3: entry.message?.created_at
  if (entryTime === null && entry.message?.created_at) {
    entryTime = new Date(entry.message.created_at).getTime();
  }

  // Priority 4: entry.time
  if (entryTime === null && entry.time !== undefined) {
    entryTime = entry.time;
  }

  // Priority 5: Fallback estimation
  if (entryTime === null || isNaN(entryTime)) {
    // Estimate: 60 seconds per entry
    entryTime = now - (entryIndex * 60 * 1000);
  }

  // Ensure non-negative age
  return Math.max(0, now - entryTime);
}
