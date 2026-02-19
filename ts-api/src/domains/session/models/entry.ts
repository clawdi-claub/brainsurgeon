// Session and entry types - strict typing, no any

// Content blocks in messages
export type ContentBlock =
  | TextContent
  | ImageContent
  | ToolCallContent
  | ToolResultContent;

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ImageContent {
  type: 'image';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

export interface ToolCallContent {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultContent {
  type: 'tool_result';
  tool_use_id: string;
  content: ContentBlock[];
  is_error?: boolean;
}

// Discriminated union for entry types
export type SessionEntry =
  | MessageEntry
  | ToolCallEntry
  | ToolResultEntry
  | CompactionEntry
  | BranchSummaryEntry
  | CustomEntry;

// Base entry with common fields
interface BaseEntry {
  id: string;
  parentId?: string;
  timestamp: number;
}

export interface MessageEntry extends BaseEntry {
  type: 'message';
  role: 'user' | 'assistant' | 'system';
  content: ContentBlock[];
  model?: string;
  usage?: TokenUsage;
}

export interface ToolCallEntry extends BaseEntry {
  type: 'tool_call';
  toolCallId: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResultEntry extends BaseEntry {
  type: 'tool_result';
  toolCallId: string;
  content: ContentBlock[];
  toolName?: string;
}

export interface CompactionEntry extends BaseEntry {
  type: 'compaction';
  summary: string;
  firstKeptEntryId: string;
  compactedCount: number;
}

export interface BranchSummaryEntry extends BaseEntry {
  type: 'branch_summary';
  summary: string;
  branchId: string;
}

export interface CustomEntry extends BaseEntry {
  type: 'custom';
  data: unknown;
}

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
  entries: SessionEntry[];
  metadata: SessionMetadata;
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

// Session list item (from sessions.json)
export interface SessionListItem {
  id: string;
  agentId: string;
  title?: string;
  createdAt: number;
  updatedAt: number;
  entryCount: number;
  tokenCount?: number;
  status: 'active' | 'stale' | 'archived';
  currentModel?: string;
  modelsUsed?: string[];
  toolCallCount?: number;
}

// Type guards
export function isMessageEntry(entry: SessionEntry): entry is MessageEntry {
  return entry.type === 'message';
}

export function isToolCallEntry(entry: SessionEntry): entry is ToolCallEntry {
  return entry.type === 'tool_call';
}

export function isToolResultEntry(entry: SessionEntry): entry is ToolResultEntry {
  return entry.type === 'tool_result';
}

export function isCompactionEntry(entry: SessionEntry): entry is CompactionEntry {
  return entry.type === 'compaction';
}

export function isBranchSummaryEntry(entry: SessionEntry): entry is BranchSummaryEntry {
  return entry.type === 'branch_summary';
}

export function isCustomEntry(entry: SessionEntry): entry is CustomEntry {
  return entry.type === 'custom';
}

export function hasToolCalls(entry: SessionEntry): boolean {
  if (!isMessageEntry(entry)) return false;
  return entry.content.some(c => c.type === 'tool_use');
}

export function getToolCallCount(entry: SessionEntry): number {
  if (!isMessageEntry(entry)) return 0;
  return entry.content.filter(c => c.type === 'tool_use').length;
}
