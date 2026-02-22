/**
 * Key-Level Extraction Logic
 * Extracts specified keys from entries and replaces them with [[extracted]] placeholders
 */

import type { SessionEntry } from '../trigger/trigger-detector.js';

/**
 * Result of extraction operation
 */
export interface ExtractionResult {
  /** Extraction succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** Keys that were extracted */
  extractedKeys: string[];
  /** Size in bytes of extracted data */
  extractedSize: number;
  /** Size per key for logging */
  sizesBytes: Record<string, number>;
  /** Entry with placeholders in main session */
  modifiedEntry: SessionEntry;
  /** Data to write to extracted file */
  extractedData: Record<string, any>;
}

/**
 * Keys that are never extracted (metadata, identification, and structural/linking fields)
 * These define entry identity, relationships, and control flags - extracting them corrupts sessions.
 */
const METADATA_KEYS = [
  // Identity
  '__id', 'id', '__ts', '__meta', '__hash', 'type', 'customType', 'timestamp',
  // Structural/linking (parent-child relationships between entries)
  'parentId', 'toolCallId', 'toolUseId', 'tool_call_id',
  // Session-level
  'version', 'cwd',
  // Entry metadata/control flags (underscore-prefixed)
  '_extractable', '_restored', '_pruned', '_pruned_type', '_has_tool_calls',
  // Model/provider context
  'modelId', 'provider', 'thinkingLevel',
  // Compaction fields
  'firstKeptEntryId', 'fromHook', 'tokensBefore',
];

/**
 * Keys that should always be extracted for thinking entries
 */
const THINKING_EXTRACT_KEYS = ['thinking', 'reasoning', 'chain_of_thought'];

/**
 * Keys that should be extracted for tool results
 */
const TOOL_RESULT_EXTRACT_KEYS = ['output', 'result', 'content', 'data'];

/**
 * Extract keys from an entry based on its type
 *
 * Strategy:
 * - Extract all keys except metadata (__*) and entry identification
 * - Replace extracted values with "[[extracted]]" placeholder
 * - If keepChars > 0, prefix placeholder with first N chars: "{firstN}... [[extracted]]"
 * - Keep __id in main entry for cross-reference
 *
 * @param entry - Original session entry
 * @param triggerType - Type that triggered extraction (determines which keys)
 * @param keepChars - Optional: preserve first N chars in placeholder (0 = no truncation)
 * @returns ExtractionResult with modified entry and extracted data
 */
export function extractEntryKeys(
  entry: SessionEntry,
  triggerType: string,
  keepChars: number = 0
): ExtractionResult {
  try {
    const extractedKeys: string[] = [];
    const extractedData: Record<string, any> = {};
    const sizesBytes: Record<string, number> = {};
    const modifiedEntry: SessionEntry = { ...entry };

    // Get entry ID for placeholder format [[extracted-${entryId}]]
    const entryId = entry.__id || entry.id || 'unknown';
    const placeholder = `[[extracted-${entryId}]]`;

    // Determine which keys to extract based on trigger type
    const keysToExtract = determineKeysToExtract(entry, triggerType);

    for (const key of keysToExtract) {
      // Skip metadata keys
      if (METADATA_KEYS.includes(key)) continue;

      // Skip if key doesn't exist
      if (!(key in entry)) continue;

      const value = entry[key];

      // Skip non-serializable values (functions, etc.)
      if (typeof value === 'function') continue;

      // Calculate size before extracting
      const sizeBytes = Buffer.byteLength(JSON.stringify(value), 'utf8');

      // Extract the value (full content goes to extraction file)
      extractedData[key] = value;
      extractedKeys.push(key);
      sizesBytes[key] = sizeBytes;

      // Determine placeholder value
      let placeholderValue: string;
      if (keepChars > 0 && typeof value === 'string') {
        // Preserve first keepChars chars, add truncation marker, then placeholder
        const truncated = value.slice(0, keepChars);
        placeholderValue = `${truncated}... ${placeholder}`;
      } else {
        // Default: full placeholder only
        placeholderValue = placeholder;
      }

      // Replace with placeholder in modified entry
      modifiedEntry[key] = placeholderValue;
    }

    // Handle nested data structures
    if (entry.data && typeof entry.data === 'object') {
      const nestedResult = extractNestedData(
        entry.data,
        triggerType,
        'data',
        placeholder
      );

      if (nestedResult.extractedKeys.length > 0) {
        extractedKeys.push(...nestedResult.extractedKeys.map(k => `data.${k}`));
        Object.assign(extractedData, nestedResult.extractedData);
        Object.assign(sizesBytes, nestedResult.sizesBytes);
        modifiedEntry.data = nestedResult.modifiedData;
      }
    }

    // Add metadata
    extractedData.__meta = {
      extracted_at: new Date().toISOString(),
      trigger_type: triggerType,
      original_keys: keysToExtract.filter(k => k in entry),
    };

    const extractedSize = JSON.stringify(extractedData).length;

    return {
      success: true,
      extractedKeys,
      extractedSize,
      sizesBytes,
      modifiedEntry,
      extractedData,
    };

  } catch (err: any) {
    return {
      success: false,
      error: err.message,
      extractedKeys: [],
      extractedSize: 0,
      sizesBytes: {},
      modifiedEntry: entry,
      extractedData: {},
    };
  }
}

/**
 * Determine which keys to extract based on entry type
 */
function determineKeysToExtract(
  entry: SessionEntry,
  triggerType: string
): string[] {
  // Never extract identification, metadata, structural, or control keys
  const NEVER_EXTRACT = [
    // Identity & type
    'id', '__id', 'type', 'customType', 'timestamp', 'role',
    // Structural/linking
    'parentId', 'toolCallId', 'toolUseId', 'tool_call_id',
    // Session-level
    'version', 'cwd',
    // Control flags
    '_extractable', '_restored', '_pruned', '_pruned_type', '_has_tool_calls',
    // Model/provider context
    'modelId', 'provider', 'thinkingLevel',
    // Compaction
    'firstKeptEntryId', 'fromHook', 'tokensBefore',
  ];

  const allKeys = Object.keys(entry).filter(k => !k.startsWith('__') && !NEVER_EXTRACT.includes(k));

  switch (triggerType) {
    case 'thinking':
      // Extract thinking-specific keys first, then any remaining content keys
      return [
        ...THINKING_EXTRACT_KEYS,
        ...allKeys.filter(k => !THINKING_EXTRACT_KEYS.includes(k))
      ];

    case 'tool_result':
      // Extract tool result keys
      return [
        ...TOOL_RESULT_EXTRACT_KEYS,
        ...allKeys.filter(k => !TOOL_RESULT_EXTRACT_KEYS.includes(k))
      ];

    case 'assistant':
    case 'user':
    case 'system':
      // Extract content/message keys for role-based types
      return allKeys.filter(k =>
        ['content', 'message', 'text', 'response'].includes(k) ||
        !['role'].includes(k)
      );

    default:
      // Default: extract all non-metadata keys
      return allKeys;
  }
}

/**
 * Extract keys from nested data object
 */
function extractNestedData(
  data: Record<string, any>,
  triggerType: string,
  prefix: string,
  placeholder: string
): {
  extractedKeys: string[];
  extractedData: Record<string, any>;
  sizesBytes: Record<string, number>;
  modifiedData: Record<string, any>;
} {
  const extractedKeys: string[] = [];
  const extractedData: Record<string, any> = {};
  const sizesBytes: Record<string, number> = {};
  const modifiedData: Record<string, any> = { ...data };

  // Determine which nested keys to extract
  let keysToCheck: string[] = [];

  switch (triggerType) {
    case 'thinking':
      keysToCheck = THINKING_EXTRACT_KEYS.filter(k => k in data);
      break;
    case 'tool_result':
      keysToCheck = TOOL_RESULT_EXTRACT_KEYS.filter(k => k in data);
      break;
    default:
      keysToCheck = Object.keys(data).filter(k =>
        typeof data[k] === 'string' && data[k].length > 100
      );
  }

  for (const key of keysToCheck) {
    if (key in data) {
      const sizeBytes = Buffer.byteLength(JSON.stringify(data[key]), 'utf8');
      extractedData[key] = data[key];
      extractedKeys.push(`${prefix}.${key}`);
      sizesBytes[`${prefix}.${key}`] = sizeBytes;
      modifiedData[key] = placeholder;
    }
  }

  return { extractedKeys, extractedData, sizesBytes, modifiedData };
}

/**
 * Create a placeholder entry for the main session
 * Keeps __id and replaces all other content with [[extracted]]
 *
 * @param entry - Original entry
 * @returns Placeholder entry for main session
 */
export function createPlaceholderEntry(entry: SessionEntry): SessionEntry {
  const placeholder: SessionEntry = {
    __id: entry.__id,
    type: entry.type,
    customType: entry.customType,
    // Everything else becomes [[extracted]]
  };

  // Copy any __* metadata fields
  for (const key of Object.keys(entry)) {
    if (key.startsWith('__') && key !== '__id') {
      placeholder[key] = entry[key];
    }
  }

  return placeholder;
}

/**
 * Check if an entry has any [[extracted-${entryId}]] placeholders
 * Used to prevent double-extraction and detect extractable entries
 *
 * @param entry - Entry to check
 * @returns true if already has extracted placeholders
 */
export function hasExtractedPlaceholders(entry: SessionEntry): boolean {
  const json = JSON.stringify(entry);
  return json.includes('[[extracted-');
}

/**
 * Extract the entry ID from an extracted placeholder value
 * Placeholder format: [[extracted-${entryId}]]
 *
 * @param value - Placeholder string
 * @returns entry ID or null if not a valid placeholder
 */
export function extractEntryIdFromPlaceholder(value: string): string | null {
  const match = value.match(/\[\[extracted-(.+)\]\]/);
  return match ? match[1] : null;
}

/**
 * Restore extracted content back into an entry
 *
 * @param placeholderEntry - Entry with [[extracted-${entryId}]] placeholders
 * @param extractedData - Data from extracted file
 * @returns Restored entry with actual values
 */
export function restoreExtractedContent(
  placeholderEntry: SessionEntry,
  extractedData: Record<string, any>
): SessionEntry {
  const restored: SessionEntry = { ...placeholderEntry };

  // Remove __meta from extracted data (it's metadata, not content)
  const { __meta, ...contentData } = extractedData;

  // Replace [[extracted-${entryId}]] placeholders with actual values
  // Note: uses includes() to handle truncated placeholders like "firstN... [[extracted-id]]"
  for (const key of Object.keys(restored)) {
    const value = restored[key];
    if (typeof value === 'string' && value.includes('[[extracted-')) {
      if (key in contentData) {
        restored[key] = contentData[key];
      }
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      // Recursively restore nested objects (not just 'data')
      const nestedExtracted = contentData[key] || {};
      restored[key] = restoreNestedContent(value, nestedExtracted, 1);
    } else if (Array.isArray(value)) {
      // Recursively restore arrays
      const extractedArray = contentData[key] || [];
      restored[key] = value.map((item: any, index: number) => {
        if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
          const itemExtracted = (Array.isArray(extractedArray) && extractedArray[index]) || {};
          return restoreNestedContent(item, itemExtracted, 1);
        }
        // For primitives in arrays, check if it's a placeholder
        if (typeof item === 'string' && item.startsWith('[[extracted-')) {
          const extractedKey = extractEntryIdFromPlaceholder(item);
          if (extractedKey && Array.isArray(extractedArray) && extractedArray[index]) {
            return extractedArray[index];
          }
        }
        return item;
      });
    }
  }

  return restored;
}

/**
 * Restore content in nested data object (recursive with max depth)
 *
 * @param placeholderData - Object with [[extracted-${entryId}]] placeholders
 * @param extractedData - Data from extracted file
 * @param depth - Current recursion depth (default: 0, max: 10)
 * @returns Restored object with actual values
 */
function restoreNestedContent(
  placeholderData: Record<string, any>,
  extractedData: Record<string, any>,
  depth: number = 0
): Record<string, any> {
  const MAX_DEPTH = 10;

  if (depth > MAX_DEPTH) {
    // Return as-is if max depth reached
    return { ...placeholderData };
  }

  const restored: Record<string, any> = {};

  for (const key of Object.keys(placeholderData)) {
    const value = placeholderData[key];

    // Note: uses includes() to handle truncated placeholders like "firstN... [[extracted-id]]"
    if (typeof value === 'string' && value.includes('[[extracted-')) {
      // Replace placeholder with extracted value
      if (key in extractedData) {
        restored[key] = extractedData[key];
      } else {
        restored[key] = value; // Keep placeholder if no extracted value
      }
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      // Recursively restore nested objects
      const nestedExtracted = extractedData[key] || {};
      restored[key] = restoreNestedContent(value, nestedExtracted, depth + 1);
    } else if (Array.isArray(value)) {
      // Handle arrays - recursively restore each element
      const extractedArray = extractedData[key] || [];
      restored[key] = value.map((item: any, index: number) => {
        if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
          // For array items, use the corresponding item from extracted array
          const itemExtracted = (Array.isArray(extractedArray) && extractedArray[index]) || {};
          return restoreNestedContent(item, itemExtracted, depth + 1);
        }
        // For primitives in arrays, check if it's a placeholder
        if (typeof item === 'string' && item.startsWith('[[extracted-')) {
          const extractedKey = extractEntryIdFromPlaceholder(item);
          if (extractedKey && Array.isArray(extractedArray) && extractedArray[index]) {
            return extractedArray[index];
          }
        }
        return item;
      });
    } else {
      // Primitive value - copy as-is
      restored[key] = value;
    }
  }

  return restored;
}
