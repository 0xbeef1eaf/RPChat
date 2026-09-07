import { z } from 'zod';
import { RpError } from '@rp/shared';
import { normalizeRelativePath } from './paths.js';

/** A path relative to the pack (or character) directory that cannot escape it. */
export const relativePathSchema = z
  .string()
  .min(1, 'path must not be empty')
  .check((ctx) => {
    const n = normalizeRelativePath(ctx.value);
    if (!n.ok) ctx.issues.push({ code: 'custom', message: `unsafe path "${ctx.value}": ${n.reason}`, input: ctx.value });
  });

/** One validation problem, JSON-safe, as carried in `RpError.details.issues`. */
export interface ValidationIssue {
  path: string;
  message: string;
}

export function issuesOf(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.') || '(root)',
    message: issue.message,
  }));
}

export function invalidError(what: string, error: z.ZodError): RpError {
  const issues = issuesOf(error);
  const summary = issues.map((i) => `${i.path}: ${i.message}`).join('; ');
  return new RpError('PACK_INVALID', `Invalid ${what}: ${summary}`, { issues });
}
