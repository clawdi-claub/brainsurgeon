import type { Session, SessionListItem } from '../models/entry.js';
import { hasExtractedPlaceholders } from '../../prune/extraction/key-level-extraction.js';

/**
 * Maps internal types to Python API-compatible response format
 * for frontend backward compatibility.
 *
 * OpenClaw JSONL entries use a nested format:
 *   { type: "message", message: { role, content, model } }
 * The frontend expects raw entries passed through as-is.
 */

// Generic record type for raw OpenClaw JSONL entries
type RawEntry = Record<string, unknown>;

export interface SessionInfoResponse {
  id: string;
  agent: string;
  label: string;
  path: string;
  size: number;
  messages: number;
  tool_calls: number;
  tool_outputs: number;
  created: string | null;
  updated: string | null;
  duration_minutes: number | null;
  model: string | null;
  models: string[];
  is_stale: boolean;
  status: string;
}

export interface SessionDetailResponse {
  id: string;
  agent: string;
  label: string;
  path: string;
  size: number;
  raw_content: string;
  entries: RawEntry[];
  messages: number;
  tool_calls: number;
  tool_outputs: number;
  duration_minutes: number | null;
  is_stale: boolean;
  created: string | null;
  updated: string | null;
  models: string[];
  tokens: number | null;
  // Extra metadata from sessions.json (Python API parity)
  channel: string | null;
  contextTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  parentId: string | null;
  children: Array<{ sessionId: string; label: string }>;
  compactionCount: number | null;
  systemPromptReport: string | null;
  resolvedSkills: string[];
}

const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

function isStale(updatedAt: number): boolean {
  return Date.now() - updatedAt > STALE_THRESHOLD_MS;
}

function toIsoString(ts: number): string | null {
  return ts ? new Date(ts).toISOString() : null;
}

function computeDuration(createdAt: number, updatedAt: number): number | null {
  if (!createdAt || !updatedAt) return null;
  return Math.round((updatedAt - createdAt) / 60_000);
}

export function mapSessionListItem(item: SessionListItem): SessionInfoResponse {
  const stale = isStale(item.updatedAt);

  return {
    id: item.id,
    agent: item.agentId,
    label: item.title || item.id.slice(0, 8),
    path: '',
    size: item.sizeBytes || 0,
    messages: item.messageCount ?? item.entryCount,
    tool_calls: item.toolCallCount || 0,
    tool_outputs: item.toolOutputCount || 0,
    created: toIsoString(item.createdAt),
    updated: toIsoString(item.updatedAt),
    duration_minutes: computeDuration(item.createdAt, item.updatedAt),
    model: item.currentModel || null,
    models: item.modelsUsed || [],
    is_stale: stale,
    status: stale ? 'stale' : 'active',
  };
}

/** Analyze raw OpenClaw JSONL entries for stats */
function analyzeEntries(entries: RawEntry[]) {
  let messages = 0;
  let toolCalls = 0;
  let toolOutputs = 0;
  const models = new Set<string>();

  for (const entry of entries) {
    const entryType = entry.type as string;

    if (entryType === 'message') {
      const msg = entry.message as Record<string, unknown> | undefined;
      if (!msg) continue;

      const role = msg.role as string;
      if (role === 'user' || role === 'assistant') messages++;
      if (role === 'toolResult') toolOutputs++;

      const model = msg.model as string | undefined;
      if (model) models.add(model);

      // Count toolCall items in content array
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const item of content) {
          if (item && typeof item === 'object' && (item as Record<string, unknown>).type === 'toolCall') {
            toolCalls++;
          }
        }
      }
    } else if (entryType === 'tool_call') {
      toolCalls++;
    } else if (entryType === 'tool_result' || entryType === 'tool') {
      toolOutputs++;
    }
  }

  return { messages, toolCalls, toolOutputs, models: Array.from(models) };
}

export function mapSessionDetail(
  id: string,
  agentId: string,
  entries: RawEntry[],
  metadata: { createdAt: number; updatedAt: number; title?: string },
  rawMeta?: Session['rawMeta'],
  children?: Array<{ sessionId: string; label: string }>,
): SessionDetailResponse {
  const stale = isStale(metadata.updatedAt);
  const stats = analyzeEntries(entries);

  // Annotate entries that have [[extracted]] placeholders
  const annotatedEntries = entries.map(entry => {
    if (hasExtractedPlaceholders(entry)) {
      return { ...entry, _extracted: true };
    }
    return entry;
  });

  return {
    id,
    agent: agentId,
    label: metadata.title || id.slice(0, 8),
    path: '',
    size: 0,
    raw_content: '',
    entries: annotatedEntries,
    messages: stats.messages,
    tool_calls: stats.toolCalls,
    tool_outputs: stats.toolOutputs,
    duration_minutes: computeDuration(metadata.createdAt, metadata.updatedAt),
    is_stale: stale,
    created: toIsoString(metadata.createdAt),
    updated: toIsoString(metadata.updatedAt),
    models: stats.models,
    tokens: rawMeta?.tokens ?? null,
    channel: rawMeta?.channel ?? null,
    contextTokens: rawMeta?.contextTokens ?? null,
    inputTokens: rawMeta?.inputTokens ?? null,
    outputTokens: rawMeta?.outputTokens ?? null,
    parentId: rawMeta?.parentSessionId ?? null,
    children: children ?? [],
    compactionCount: rawMeta?.compactionCount ?? null,
    systemPromptReport: rawMeta?.systemPromptReport ?? null,
    resolvedSkills: rawMeta?.resolvedSkills ?? [],
  };
}
