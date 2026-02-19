// domains/session/index.ts - public API
export { SessionService } from './services/session-service.js';
export { PruneService } from './services/prune-service.js';
export { createSessionRoutes } from './api/routes.js';

// Models
export type {
  Session,
  SessionEntry,
  SessionListItem,
  SessionMetadata,
  TokenUsage,
  ContentBlock,
  MessageEntry,
  ToolCallEntry,
  ToolResultEntry,
  CompactionEntry,
} from './models/entry.js';

// Guards
export {
  isMessageEntry,
  isToolCallEntry,
  isToolResultEntry,
  isCompactionEntry,
} from './models/entry.js';
