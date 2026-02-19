/**
 * Session summary generation — ported from Python api/main.py
 * Generates a rich summary for the pre-delete dialog.
 */

import type { JsonEntry } from '../models/entry.js';

export interface SessionSummary {
  session_type: 'chat' | 'development' | 'tool_heavy' | 'long_chat';
  key_actions: string[];
  user_requests: string[];
  thinking_insights: string[];
  tools_used: string[];
  models_used: string[];
  errors: string[];
  duration_estimate: number | null;
  message_count: number;
  user_messages: number;
  meaningful_messages: number;
  tool_calls: number;
  has_git_commits: boolean;
  files_created: string[];
}

const HEARTBEAT_INDICATORS = [
  'heartbeat',
  'heartbeat_ok',
  'checking token',
  'context compacted',
  'compacted (',
  'tokens:',
  'token count',
  'system: [',
  '[system]',
  "you've been rate limited",
  'rate limit',
  'compacting context',
  'continue on your open tasks',
];

function isHeartbeatMessage(text: string): boolean {
  if (!text) return true;
  const lower = text.toLowerCase();
  return HEARTBEAT_INDICATORS.some(ind => lower.includes(ind));
}

export function generateSessionSummary(entries: JsonEntry[]): SessionSummary {
  const summary: {
    session_type: SessionSummary['session_type'];
    key_actions: string[];
    user_requests: string[];
    thinking_insights: string[];
    tools_used: Set<string>;
    models_used: Set<string>;
    errors: string[];
    duration_estimate: number | null;
    message_count: number;
    user_messages: number;
    meaningful_messages: number;
    tool_calls: number;
    has_git_commits: boolean;
    files_created: Set<string>;
  } = {
    session_type: 'chat',
    key_actions: [],
    user_requests: [],
    thinking_insights: [],
    tools_used: new Set(),
    models_used: new Set(),
    errors: [],
    duration_estimate: null,
    message_count: 0,
    user_messages: 0,
    meaningful_messages: 0,
    tool_calls: 0,
    has_git_commits: false,
    files_created: new Set(),
  };

  const seen = new Set<string>();
  let firstTimestamp: string | null = null;
  let lastTimestamp: string | null = null;

  for (const entry of entries) {
    const type = entry.type as string;

    // Track timestamps
    const ts = entry.timestamp as string | undefined;
    if (ts) {
      if (!firstTimestamp) firstTimestamp = ts;
      lastTimestamp = ts;
    }

    // model-snapshot custom entries
    if (type === 'custom') {
      const customType = entry.customType as string | undefined;
      if (customType === 'model-snapshot') {
        const data = entry.data as Record<string, unknown> | undefined;
        const modelId = data?.modelId as string | undefined;
        if (modelId) summary.models_used.add(modelId);
      }
      continue;
    }

    if (type !== 'message') continue;

    summary.message_count++;
    const msg = entry.message as Record<string, unknown> | undefined;
    if (!msg) continue;

    const role = msg.role as string;
    const content = msg.content;
    const model = msg.model as string | undefined;
    if (model) summary.models_used.add(model);

    // --- ASSISTANT messages ---
    if (role === 'assistant') {
      // Tool calls (OpenAI format)
      const toolCalls = msg.tool_calls as Array<Record<string, unknown>> | undefined;
      if (toolCalls) {
        summary.tool_calls += toolCalls.length;
        for (const tc of toolCalls) {
          const name = tc.name as string ?? (tc.function as Record<string, unknown>)?.name as string;
          if (name) summary.tools_used.add(name);
        }
      }

      let hasMeaningful = false;

      if (Array.isArray(content)) {
        for (const item of content as Array<Record<string, unknown>>) {
          const itemType = item.type as string;

          if (itemType === 'toolCall') {
            summary.tool_calls++;
            const name = item.name as string | undefined;
            if (name) summary.tools_used.add(name);
          }

          if (itemType === 'thinking') {
            const thinking = item.thinking as string ?? '';
            if (isHeartbeatMessage(thinking) || thinking.length < 30) continue;
            hasMeaningful = true;
            const lines = thinking.split('\n').filter(l => l.trim());
            for (const line of lines.slice(0, 3)) {
              if (line.length > 20 && line.length < 200 && !seen.has(line)) {
                seen.add(line);
                summary.thinking_insights.push(line);
              }
            }
          }

          if (itemType === 'text') {
            const text = item.text as string ?? '';
            if (isHeartbeatMessage(text)) continue;
            hasMeaningful = true;

            const ACTION_KW = ['implement', 'build', 'create', 'fix', 'add', 'update',
              'deploy', 'configure', 'refactor', 'integrate', 'optimize'];
            if (ACTION_KW.some(kw => text.toLowerCase().includes(kw))) {
              const sentence = text.split('.')[0]?.slice(0, 120) ?? '';
              if (sentence.length > 20 && !seen.has(sentence)) {
                seen.add(sentence);
                summary.key_actions.push(sentence);
              }
            }
          }
        }
      }

      if (hasMeaningful) summary.meaningful_messages++;

      // Error detection
      const errMsg = msg.errorMessage as string | undefined;
      const stopReason = msg.stopReason as string | undefined;
      if (errMsg || stopReason === 'error') {
        const err = errMsg || 'Unknown error';
        if (!isHeartbeatMessage(err)) {
          summary.errors.push(err.slice(0, 200));
        }
      }
    }

    // --- USER messages ---
    if (role === 'user') {
      summary.user_messages++;
      if (Array.isArray(content)) {
        for (const item of content as Array<Record<string, unknown>>) {
          if (item.type !== 'text') continue;
          const text = item.text as string ?? '';
          if (isHeartbeatMessage(text)) continue;

          summary.meaningful_messages++;

          if (text.length > 10 && text.length < 300) {
            const sentence = text.split('.')[0]?.slice(0, 150) ?? '';
            if (sentence.length > 10 && !seen.has(sentence)) {
              seen.add(sentence);
              summary.user_requests.push(sentence);
            }
          }

          // File detection
          const FILE_EXTS = ['.py', '.js', '.ts', '.html', '.css', '.json', '.md', '.yml', '.yaml', '.sh', '.txt'];
          for (const word of text.split(/\s+/)) {
            if (word.includes('.') && word.includes('/') && FILE_EXTS.some(ext => word.includes(ext))) {
              summary.files_created.add(word.replace(/[.,;:!?()[\]{}]+$/, ''));
            }
          }
        }
      }
    }

    // --- TOOL RESULT messages ---
    if (role === 'toolResult' && Array.isArray(content)) {
      for (const item of content as Array<Record<string, unknown>>) {
        const text = item.text as string ?? '';
        if (text.toLowerCase().includes('commit') &&
          (text.includes('created') || text.includes('modified') || text.includes('deleted'))) {
          summary.has_git_commits = true;
        }
      }
    }
  }

  // Calculate duration
  if (firstTimestamp && lastTimestamp) {
    try {
      const start = new Date(firstTimestamp).getTime();
      const end = new Date(lastTimestamp).getTime();
      if (!isNaN(start) && !isNaN(end)) {
        summary.duration_estimate = Math.round((end - start) / 60_000 * 10) / 10;
      }
    } catch {
      // ignore
    }
  }

  // Determine session type
  if (summary.has_git_commits) {
    summary.session_type = 'development';
  } else if (summary.tool_calls > 5) {
    summary.session_type = 'tool_heavy';
  } else if (summary.meaningful_messages > 30) {
    summary.session_type = 'long_chat';
  }

  return {
    session_type: summary.session_type,
    key_actions: summary.key_actions.slice(0, 5),
    user_requests: summary.user_requests.slice(0, 5),
    thinking_insights: summary.thinking_insights.slice(0, 5),
    tools_used: [...summary.tools_used].sort().slice(0, 15),
    models_used: [...summary.models_used].sort(),
    errors: summary.errors.slice(0, 3),
    duration_estimate: summary.duration_estimate,
    message_count: summary.message_count,
    user_messages: summary.user_messages,
    meaningful_messages: summary.meaningful_messages,
    tool_calls: summary.tool_calls,
    has_git_commits: summary.has_git_commits,
    files_created: [...summary.files_created].sort().slice(0, 8),
  };
}
