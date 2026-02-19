import { HTTPException } from 'hono/http-exception';

/** Only allow alphanumeric, hyphens, underscores — no path traversal */
const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

export function sanitizeId(value: string, field: string): string {
  if (!value) {
    throw new HTTPException(400, { message: `${field} cannot be empty` });
  }
  if (!SAFE_ID.test(value)) {
    throw new HTTPException(400, {
      message: `Invalid ${field}: only alphanumeric characters, hyphens, and underscores are allowed`,
    });
  }
  return value;
}
