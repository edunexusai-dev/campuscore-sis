import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { AppError } from '../lib/errors.js';

export function requestId(req, res, next) {
  req.id = crypto.randomUUID();
  res.set('X-Request-Id', req.id);
  next();
}

export function notFoundHandler(req, _res, next) {
  next(new AppError(404, 'route_not_found', `No route for ${req.method} ${req.path}.`));
}

// Consistent error envelope: { error: { code, message, details?, requestId } }.
// OAuth token endpoint errors additionally use RFC 6749 fields (error, error_description).
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  let e = err;
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') e = new AppError(409, 'duplicate', `A record with this ${[].concat(err.meta?.target ?? 'value').join(', ')} already exists.`);
    else if (err.code === 'P2025') e = new AppError(404, 'not_found', 'Resource not found.');
    else if (err.code === 'P2003') e = new AppError(409, 'in_use', 'This record is referenced by other records and cannot be changed this way.');
  } else if (err.type === 'entity.too.large') {
    e = new AppError(413, 'payload_too_large', 'Request body is too large.');
  } else if (err.type === 'entity.parse.failed') {
    e = new AppError(400, 'invalid_json', 'Request body is not valid JSON.');
  }
  if (!(e instanceof AppError)) {
    console.error(`[${req.id}]`, err);
    e = new AppError(500, 'internal_error', 'An unexpected error occurred.');
  }
  res.locals.errorCode = e.code;
  const body = { error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}), requestId: req.id } };
  if (e.oauth && req.path.endsWith('/oauth/token')) Object.assign(body, { error: e.code, error_description: e.message, requestId: req.id });
  res.status(e.status).json(body);
}
