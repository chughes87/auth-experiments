export class InvariantViolation extends Error {
  constructor(message: string) {
    super(`Invariant violation: ${message}`);
    this.name = 'InvariantViolation';
  }
}

/**
 * Assert a condition that should always be true.
 * After calling invariant(x !== null, '...'), TypeScript narrows x to non-null.
 * Throws InvariantViolation if the condition is false.
 */
export function invariant(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new InvariantViolation(message);
  }
}

export class NotFoundError extends Error {
  constructor(entity: string, id: string) {
    super(`${entity} not found: ${id}`);
    this.name = 'NotFoundError';
  }
}

export class ForbiddenError extends Error {
  constructor(message = 'Insufficient permissions') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}
