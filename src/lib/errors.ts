/**
 * Typed errors. Services throw these; API routes turn them into HTTP responses
 * (see src/lib/api/http.ts). Anything that is not an HttpError is treated as an
 * unexpected failure and returned as a generic 500 without leaking details.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.code = code;
  }
}

export class ValidationError extends HttpError {
  constructor(message: string) {
    super(400, "validation_error", message);
  }
}

export class UnauthorizedError extends HttpError {
  constructor(message = "Please sign in.") {
    super(401, "unauthorized", message);
  }
}

export class ForbiddenError extends HttpError {
  constructor(message = "You don't have permission to do that.") {
    super(403, "forbidden", message);
  }
}

export class NotFoundError extends HttpError {
  constructor(message: string) {
    super(404, "not_found", message);
  }
}

export class ConflictError extends HttpError {
  constructor(message: string) {
    super(409, "conflict", message);
  }
}

export class TooManyRequestsError extends HttpError {
  constructor(message: string) {
    super(429, "too_many_requests", message);
  }
}

export class UnavailableError extends HttpError {
  constructor(message: string) {
    super(503, "unavailable", message);
  }
}
