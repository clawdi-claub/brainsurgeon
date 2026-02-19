// Session and entry types
// Note: OpenClaw JSONL entries use nested format:
//   { type: "message", message: { role, content, model } }
// We use raw records to handle any entry format without strict typing.

/** Raw JSON entry from OpenClaw JSONL file */
export type JsonEntry = Record<string, unknown>;

// Legacy typed names for backwards compatibility
export type SessionEntry = JsonEntry;
export type ContentBlock = JsonEntry;

// Session metadata
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens?: number;
  cost_usd?: number;
}

export interface Session {
  id: string;
  agentId: string;
  entries: JsonEntry[];
  metadata: SessionMetadata;
  /** Raw sessions.json metadata for detail view */
  rawMeta?: SessionListItem['rawMeta'];
}

export interface SessionMetadata {
  title?: string;
  createdAt: number;
  updatedAt: number;
  entryCount: number;
  tokenCount?: number;
  costUsd?: number;
  isCompacted?: boolean;
}

// Session list item (from sessions.json + JSONL analysis)
export interface SessionListItem {
  id: string;
  agentId: string;
  title?: string;
  createdAt: number;
  updatedAt: number;
  entryCount: number;
  tokenCount?: number;
  sizeBytes?: number;
  status: 'active' | 'stale' | 'archived';
  currentModel?: string;
  modelsUsed?: string[];
  toolCallCount?: number;
  messageCount?: number;
  toolOutputCount?: number;
  // Raw sessions.json metadata for detail view
  rawMeta?: {
    channel?: string;
    tokens?: number;
    contextTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
    parentSessionId?: string;
    compactionCount?: number;
    systemPromptReport?: string;
    resolvedSkills?: string[];
  };
}

// Legacy type guards (always return false for raw records)
export function isMessageEntry(entry: JsonEntry): boolean {
  return entry.type === 'message';
}

export function isToolCallEntry(entry: JsonEntry): boolean {
  return entry.type === 'tool_call';
}

export function isToolResultEntry(entry: JsonEntry): boolean {
  return entry.type === 'tool_result' || entry.type === 'tool';
}

export function isCompactionEntry(entry: JsonEntry): boolean {
  return entry.type === 'compaction';
}

export function isBranchSummaryEntry(entry: JsonEntry): boolean {
  return entry.type === 'branch_summary';
}

export function isCustomEntry(entry: JsonEntry): boolean {
  return entry.type === 'custom';
}

export function hasToolCalls(_entry: JsonEntry): boolean {
  // Would need to check nested message.content - use analyzeEntries instead
  return false;
}

export function getToolCallCount(_entry: JsonEntry): number {
  return 0;
}
