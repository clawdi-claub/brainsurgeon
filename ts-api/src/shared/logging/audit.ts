/**
 * Audit logging for destructive operations.
 * Uses structured pino logger at info level.
 */
import { createLogger } from './logger.js';

const log = createLogger('audit');

export function auditLog(
  action: string,
  agent: string,
  sessionId?: string,
  apiKey?: string,
  details?: Record<string, unknown>
): void {
  log.info({
    audit: true,
    action,
    agent,
    ...(sessionId ? { session: sessionId } : {}),
    ...(apiKey ? { user: apiKey.slice(0, 8) + '...' } : {}),
    ...(details ? { details } : {}),
  }, `audit: ${action}`);
}
