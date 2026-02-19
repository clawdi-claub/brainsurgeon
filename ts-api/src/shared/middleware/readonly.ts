import type { MiddlewareHandler } from 'hono';

export function createReadonlyMiddleware(enabled: boolean): MiddlewareHandler {
  // If not readonly, allow all requests
  if (!enabled) {
    return async (_, next) => await next();
  }

  return async (c, next) => {
    const method = c.req.method;
    
    // Allow GET, HEAD, OPTIONS
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      await next();
      return;
    }
    
    // Block write methods
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
      return c.json({ 
        error: 'Server is in read-only mode',
        readonly: true 
      }, 403);
    }
    
    await next();
  };
}
