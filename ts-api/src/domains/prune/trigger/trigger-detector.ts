/**
 * Smart Pruning Trigger Logic
 * Detects entries matching configured trigger_types and position from end
 * 
 * CORE RULE: Keep the most recent `keep_recent` messages in context.
 * Extract everything older than that threshold.
 */

import type { TriggerType } from '../../../domains/config/model/config.js';

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
 * Configuration for trigger detection
 */
export interface TriggerConfig {
  enabled: boolean;
  trigger_types: TriggerType[];
  keep_recent: number;
  min_value_length: number;
}

/**
 * Detect if an entry matches smart prune triggers
 * 
 * Preconditions (all must pass):
 * 1. Smart pruning enabled
 * 2. Entry has __id field (required for extraction)
 * 3. Entry doesn't already have [[extracted]] placeholders
 * 4. Entry type matches one of trigger_types OR _extractable override
 * 5. Entry position >= keep_recent (old enough to extract)
 * 6. Entry has content values > min_value_length (worth extracting)
 * 
 * @param entry - Session entry from JSONL
 * @param config - Trigger configuration
 * @param positionFromEnd - Position from end of session (0 = most recent)
 * @returns TriggerMatch result
 */
export function detectTrigger(
  entry: SessionEntry,
  config: TriggerConfig,
  positionFromEnd: number,
): TriggerMatch {
  // Check 1: Enabled
  if (!config.enabled) {
    return {
      matched: false,
      triggerType: null,
      hasId: false,
      positionFromEnd,
      meetsPositionThreshold: false,
      shouldExtract: false,
      skipReason: 'smart_pruning_disabled',
    };
  }

  // Check 2: Has __id or id field (OpenClaw uses 'id', we normalize to __id internally)
  const entryId = entry.__id || entry.id;
  const hasId = !!entryId;
  if (!hasId) {
    return {
      matched: false,
      triggerType: null,
      hasId: false,
      positionFromEnd,
      meetsPositionThreshold: false,
      shouldExtract: false,
      skipReason: 'no_entry_id',
    };
  }

  // Check 3: Not already extracted
  if (hasExtractedPlaceholders(entry)) {
    return {
      matched: false,
      triggerType: null,
      hasId: true,
      positionFromEnd,
      meetsPositionThreshold: false,
      shouldExtract: false,
      skipReason: 'already_extracted',
    };
  }

  // Check 4: _extractable override (can force extract or prevent extract)
  const extractableOverride = getExtractableOverride(entry, positionFromEnd, config.keep_recent);
  
  if (extractableOverride === 'force') {
    // Force extraction regardless of type
    const hasLargeValues = checkValueSizes(entry, config.min_value_length);
    return {
      matched: true,
      triggerType: 'assistant', // Default when forced
      hasId: true,
      positionFromEnd,
      meetsPositionThreshold: true,
      shouldExtract: hasLargeValues.hasLargeValues,
      skipReason: hasLargeValues.hasLargeValues ? undefined : 'values_too_small',
    };
  }
  
  if (extractableOverride === 'prevent') {
    return {
      matched: false,
      triggerType: null,
      hasId: true,
      positionFromEnd,
      meetsPositionThreshold: false,
      shouldExtract: false,
      skipReason: '_extractable_false',
    };
  }

  // Check 5: Type detection
  const detectedType = detectEntryType(entry);
  const matched = detectedType !== null && config.trigger_types.includes(detectedType);
  
  if (!matched) {
    return {
      matched: false,
      triggerType: null,
      hasId: true,
      positionFromEnd,
      meetsPositionThreshold: false,
      shouldExtract: false,
      skipReason: 'type_not_matched',
    };
  }

  // Check 6: Position threshold (keep_recent)
  // Position 0 = most recent, position keep_recent and beyond = extract
  const meetsPositionThreshold = positionFromEnd >= config.keep_recent;
  
  if (!meetsPositionThreshold) {
    return {
      matched: true,
      triggerType: detectedType,
      hasId: true,
      positionFromEnd,
      meetsPositionThreshold: false,
      shouldExtract: false,
      skipReason: 'too_recent',
    };
  }

  // Check 7: Value sizes (only extract if there's content worth extracting)
  const valueSizeCheck = checkValueSizes(entry, config.min_value_length);
  
  if (!valueSizeCheck.hasLargeValues) {
    return {
      matched: true,
      triggerType: detectedType,
      hasId: true,
      positionFromEnd,
      meetsPositionThreshold: true,
      shouldExtract: false,
      skipReason: 'values_too_small',
    };
  }

  // All checks pass - should extract
  return {
    matched: true,
    triggerType: detectedType,
    hasId: true,
    positionFromEnd,
    meetsPositionThreshold: true,
    shouldExtract: true,
  };
}

/**
 * Get _extractable override status for an entry
 * 
 * @returns 'force' | 'prevent' | 'default'
 */
function getExtractableOverride(
  entry: SessionEntry,
  positionFromEnd: number,
  keepRecent: number
): 'force' | 'prevent' | 'default' {
  const extractable = entry._extractable;
  
  if (extractable === true) {
    return 'force';
  }
  
  if (extractable === false) {
    return 'prevent';
  }
  
  if (typeof extractable === 'number') {
    // Keep for this many messages (override global keep_recent)
    if (positionFromEnd < extractable) {
      return 'prevent'; // Still within the keep window
    }
    // Beyond the custom keep window - allow normal extraction
    return 'default';
  }
  
  return 'default';
}

/**
 * Check if entry has content values larger than min_value_length
 * Returns which keys are large enough to extract
 */
export function checkValueSizes(
  entry: SessionEntry,
  minValueLength: number
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
    if (value === undefined || value === null) continue;
    
    let length = 0;
    
    if (typeof value === 'string') {
      length = value.length;
    } else if (typeof value === 'object') {
      // For objects, check the stringified length
      const str = JSON.stringify(value);
      length = str.length;
    }
    
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
  
  return {
    hasLargeValues: largeKeys.length > 0,
    largeKeys,
    totalSize,
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
  if (entry.thinking || entry.data?.thinking) {
    return 'thinking';
  }
  
  // Check for tool result patterns
  if (entry.tool_result || entry.result || entry.data?.result) {
    return 'tool_result';
  }

  return null;
}

/**
 * Check if an entry has any [[extracted]] placeholders
 * Used to prevent double-extraction
 * 
 * @param entry - Entry to check
 * @returns true if already has extracted placeholders
 */
export function hasExtractedPlaceholders(entry: SessionEntry): boolean {
  const json = JSON.stringify(entry);
  return json.includes('[[extracted]]');
}
