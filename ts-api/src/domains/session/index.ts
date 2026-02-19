// domains/session/index.ts - public API
export { SessionService } from './services/session-service.js';
export { PruneService } from './services/prune-service.js';
export { createSessionRoutes } from './api/routes.js';

// Models
export type {
  Session,
  JsonEntry,
  SessionListItem,
  SessionMetadata,
  TokenUsage,
} from './models/entry.js';

// Guards (work on JsonEntry)
export {
  isMessageEntry,
  isToolCallEntry,
  isToolResultEntry,
  isCompactionEntry,
} from './models/entry.js';
