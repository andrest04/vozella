import {
  CUSTOM_TEMPLATE_ID,
  instructionsFor,
  normalizeTemplateId,
} from '../settings/note-templates';

/** The user's template text, trimmed; null when there is none. */
function customText(custom: string | null | undefined): string | null {
  const text = (custom ?? '').trim();
  return text === '' ? null : text;
}

/**
 * `NoteTemplateInstructions.ResolveAsync` without the store. Built-in ids give their prompt text.
 * `custom` gives the user's own text when they wrote one. `auto`, blank, unknown ids and a
 * `custom` id with no text give null, so an old `custom` id on disk just means no template.
 */
export function resolveTemplateInstructions(
  id: string | null | undefined,
  custom?: string | null,
): string | null {
  const normalized = normalizeTemplateId(id);
  if (normalized === CUSTOM_TEMPLATE_ID) return customText(custom);
  return instructionsFor(normalized);
}

/**
 * The id to store on the record after a generate. A built-in template is stored, and `custom`
 * when the user has a custom template text; `auto`, blank and unknown ids are stored as null.
 */
export function templateIdToStore(
  id: string | null | undefined,
  custom?: string | null,
): string | null {
  const normalized = normalizeTemplateId(id);
  if (normalized === null) return null;
  if (normalized === CUSTOM_TEMPLATE_ID) return customText(custom) === null ? null : normalized;
  return instructionsFor(normalized) !== null ? normalized : null;
}
