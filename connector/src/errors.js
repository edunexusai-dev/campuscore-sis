// Normalised error for anything that goes wrong talking to an SIS. `retryable` tells callers
// (job queues, sync workers) whether trying again later can succeed.
export class SisError extends Error {
  constructor(message, { status = 0, code = 'sis_error', retryable = false, details, requestId } = {}) {
    super(message);
    this.name = 'SisError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.details = details;
    this.requestId = requestId;
  }
}
