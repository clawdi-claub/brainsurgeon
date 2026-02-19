/**
 * Structured logging for BrainSurgeon API.
 * Uses pino for JSON output with configurable levels.
 *
 * Usage:
 *   import { createLogger } from './shared/logging/logger.js';
 *   const log = createLogger('session-service');
 *   log.debug({ agentId, sessionId }, 'loading session');
 */

import pino from 'pino';

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

const rootLogger = pino({
  name: 'brainsurgeon',
  level: LOG_LEVEL,
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
});

/**
 * Create a child logger scoped to a module.
 * @param module - Module name (e.g. 'session-repo', 'prune-service')
 */
export function createLogger(module: string): pino.Logger {
  return rootLogger.child({ module });
}

/** Root logger for top-level app use (startup, shutdown). */
export const logger = rootLogger;
