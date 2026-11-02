import { z } from 'zod';
import { badRequest } from './errors.js';

// Parse and validate with a zod schema; throws a 400 with field-level details.
export function parse(schema, data) {
  const result = schema.safeParse(data ?? {});
  if (!result.success) {
    const details = result.error.issues.map((i) => ({ field: i.path.join('.') || '(root)', message: i.message }));
    throw badRequest('Request validation failed.', details);
  }
  return result.data;
}

export const id = z.string().min(1).max(64);
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
export const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:MM');

export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export function sortQuery(allowed, fallback) {
  return z
    .string()
    .optional()
    .transform((v) => v || fallback)
    .refine((v) => allowed.includes(v.replace(/^-/, '')), { message: `sort must be one of: ${allowed.join(', ')} (prefix with - for descending)` });
}

export const toOrderBy = (sort) => {
  const desc = sort.startsWith('-');
  return { [sort.replace(/^-/, '')]: desc ? 'desc' : 'asc' };
};

export const pageArgs = ({ page, pageSize }) => ({ skip: (page - 1) * pageSize, take: pageSize });

export const paged = (data, total, { page, pageSize }) => ({
  data,
  pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
});
