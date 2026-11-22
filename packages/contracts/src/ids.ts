import { z } from 'zod';

/**
 * A canonical GUID: 8-4-4-4-12 hex digits with hyphens. Parsing accepts either case and answers
 * the lowercase form, so two ids that differ only by case can never reach the same file path.
 */
const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The id of a project, a project file or a chat thread (the same canonical GUID). */
export const guidSchema = z
  .string()
  .regex(GUID_PATTERN, 'Expected a GUID')
  .transform((value) => value.toLowerCase());
