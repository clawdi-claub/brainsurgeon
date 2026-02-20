import type { MiddlewareHandler } from 'hono';

export function createAuthMiddleware(apiKeys: string[]): MiddlewareHandler {
  // If no keys configured, allow all requests
  if (apiKeys.length === 0) {
    return async (_, next) => await next();
  }

  return async (c, next) => {
    const providedKey = c.req.header('X-API-Key');

    if (!providedKey) {
      return c.json({ error: 'API key required. Pass X-API-Key header.' }, 401);
    }

    if (!apiKeys.includes(providedKey)) {
      return c.json({ error: 'Invalid API key' }, 403);
    }

    await next();
  };
}

/** Whether API key authentication is configured (at least one key set) */
export function isAuthEnabled(apiKeys: string[]): boolean {
  return apiKeys.length > 0;
}
