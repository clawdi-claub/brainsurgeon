/**
 * Audit logging for destructive operations.
 * Matches Python API audit log format.
 * Outputs to stderr as JSON.
 */
export function auditLog(
  action: string,
  agent: string,
  sessionId?: string,
  apiKey?: string,
  details?: Record<string, unknown>
): void {
  const entry = {
    timestamp: new Date().toISOString(),
    action,
    agent,
    ...(sessionId ? { session: sessionId } : {}),
    ...(apiKey ? { user: apiKey.slice(0, 8) + '...' } : {}),
    ...(details ? { details } : {}),
  };
  console.error('[AUDIT]', JSON.stringify(entry));
}
