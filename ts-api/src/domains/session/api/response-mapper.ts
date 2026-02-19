import type { Session, SessionListItem, SessionEntry } from '../models/entry.js';

/**
 * Maps internal types to Python API-compatible response format
 * for frontend backward compatibility.
 */

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
  entries: Record<string, unknown>[];
  messages: number;
  tool_calls: number;
  duration_minutes: number | null;
  is_stale: boolean;
  created: string | null;
  updated: string | null;
  models: string[];
  tokens: number | null;
}

const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

function toIsoString(ts: number): string | null {
  return ts ? new Date(ts).toISOString() : null;
}

function isStale(updatedAt: number): boolean {
  return Date.now() - updatedAt > STALE_THRESHOLD_MS;
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
    size: 0,
    messages: item.entryCount,
    tool_calls: item.toolCallCount || 0,
    tool_outputs: 0,
    created: toIsoString(item.createdAt),
    updated: toIsoString(item.updatedAt),
    duration_minutes: computeDuration(item.createdAt, item.updatedAt),
    model: item.currentModel || null,
    models: item.modelsUsed || [],
    is_stale: stale,
    status: stale ? 'stale' : 'active',
  };
}

export function mapSessionDetail(session: Session): SessionDetailResponse {
  const { entries, metadata } = session;
  const stale = isStale(metadata.updatedAt);

  const messageCount = entries.filter(e => e.type === 'message').length;
  const toolCallCount = countToolCalls(entries);
  const models = extractModels(entries);
  const tokens = sumTokens(entries);

  return {
    id: session.id,
    agent: session.agentId,
    label: metadata.title || session.id.slice(0, 8),
    path: '',
    size: 0,
    raw_content: '',
    entries: entries as unknown as Record<string, unknown>[],
    messages: messageCount,
    tool_calls: toolCallCount,
    duration_minutes: computeDuration(metadata.createdAt, metadata.updatedAt),
    is_stale: stale,
    created: toIsoString(metadata.createdAt),
    updated: toIsoString(metadata.updatedAt),
    models,
    tokens: tokens || null,
  };
}

function countToolCalls(entries: SessionEntry[]): number {
  let count = 0;
  for (const entry of entries) {
    if (entry.type === 'tool_call') {
      count++;
    } else if (entry.type === 'message' && 'content' in entry) {
      count += entry.content.filter(c => c.type === 'tool_use').length;
    }
  }
  return count;
}

function extractModels(entries: SessionEntry[]): string[] {
  const models = new Set<string>();
  for (const entry of entries) {
    if (entry.type === 'message' && 'model' in entry && entry.model) {
      models.add(entry.model);
    }
  }
  return Array.from(models);
}

function sumTokens(entries: SessionEntry[]): number {
  let total = 0;
  for (const entry of entries) {
    if (entry.type === 'message' && 'usage' in entry && entry.usage) {
      total += entry.usage.total_tokens || (entry.usage.input_tokens + entry.usage.output_tokens);
    }
  }
  return total;
}
