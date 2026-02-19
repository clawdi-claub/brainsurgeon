import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

export interface JsonlParseOptions {
  /** Maximum number of lines to parse (for preview) */
  limit?: number;
  /** Skip malformed lines instead of throwing */
  skipInvalid?: boolean;
}

export interface JsonlEntry {
  [key: string]: unknown;
}

/**
 * Parse a JSONL string into entries
 */
export function parseJsonl(content: string, options: JsonlParseOptions = {}): JsonlEntry[] {
  const { limit, skipInvalid = true } = options;
  const lines = content.split('\n').filter(l => l.trim());
  const entries: JsonlEntry[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (limit && entries.length >= limit) break;

    const line = lines[i];
    try {
      const entry = JSON.parse(line) as JsonlEntry;
      entries.push(entry);
    } catch (err) {
      if (!skipInvalid) {
        throw new Error(`Invalid JSON at line ${i + 1}: ${line.slice(0, 100)}`);
      }
      // Skip invalid lines
    }
  }

  return entries;
}

/**
 * Serialize entries to JSONL format
 */
export function serializeJsonl(entries: JsonlEntry[]): string {
  return entries.map(e => JSON.stringify(e)).join('\n') + '\n';
}

/**
 * Stream parse a JSONL file (memory-efficient for large files)
 */
export async function* streamJsonl(
  filePath: string,
  options: JsonlParseOptions = {}
): AsyncGenerator<JsonlEntry, void, unknown> {
  const { limit, skipInvalid = true } = options;

  const fileStream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  let count = 0;

  for await (const line of rl) {
    if (limit && count >= limit) break;
    if (!line.trim()) continue;

    try {
      const entry = JSON.parse(line) as JsonlEntry;
      count++;
      yield entry;
    } catch (err) {
      if (!skipInvalid) {
        throw new Error(`Invalid JSON: ${line.slice(0, 100)}`);
      }
    }
  }
}

/**
 * Count entries in a JSONL file without loading them all
 */
export async function countJsonlEntries(filePath: string): Promise<number> {
  let count = 0;
  for await (const _ of streamJsonl(filePath)) {
    count++;
  }
  return count;
}

/**
 * Get the last N entries from a JSONL file efficiently
 */
export async function getLastEntries(
  filePath: string,
  n: number
): Promise<JsonlEntry[]> {
  const entries: JsonlEntry[] = [];

  for await (const entry of streamJsonl(filePath)) {
    entries.push(entry);
    if (entries.length > n) {
      entries.shift(); // Keep only last N
    }
  }

  return entries;
}
