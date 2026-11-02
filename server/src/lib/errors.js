// A single error type carries HTTP status + a stable machine-readable code.
export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, details) => new AppError(400, 'validation_error', message, details);
export const unauthorized = (message = 'Authentication required.', code = 'unauthenticated') => new AppError(401, code, message);
export const forbidden = (message = 'You do not have permission to perform this action.', code = 'forbidden') => new AppError(403, code, message);
export const notFound = (what = 'Resource') => new AppError(404, 'not_found', `${what} not found.`);
export const conflict = (message, code = 'conflict', details) => new AppError(409, code, message, details);
// 422: request is well-formed but violates an academic business rule or institutional policy.
export const ruleViolation = (code, message, details) => new AppError(422, code, message, details);
