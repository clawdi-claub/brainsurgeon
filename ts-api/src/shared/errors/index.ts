// Global error types

export class BrainSurgeonError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500
  ) {
    super(message);
    this.name = 'BrainSurgeonError';
  }
}

export class NotFoundError extends BrainSurgeonError {
  constructor(resource: string, id: string) {
    super(`${resource} not found: ${id}`, 'NOT_FOUND', 404);
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends BrainSurgeonError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR', 400);
    this.name = 'ValidationError';
  }
}

export class LockError extends BrainSurgeonError {
  constructor(sessionFile: string) {
    super(`Failed to acquire lock for: ${sessionFile}`, 'LOCK_ERROR', 409);
    this.name = 'LockError';
  }
}

export class SessionLockedError extends BrainSurgeonError {
  constructor(sessionFile: string) {
    super(`Session is currently locked: ${sessionFile}`, 'SESSION_LOCKED', 423);
    this.name = 'SessionLockedError';
  }
}
