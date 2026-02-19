// JSONL TypeScript Library for BrainSurgeon
// Replaces direct file I/O with structured JSONL operations

export {
  parseJsonl,
  serializeJsonl,
  streamJsonl,
  countJsonlEntries,
  getLastEntries,
} from './parser.js';

export type { JsonlEntry, JsonlParseOptions } from './parser.js';
