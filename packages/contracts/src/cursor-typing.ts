import { z } from 'zod';
import { defineEvent, defineRequest } from './channel';

/**
 * Type at cursor channels (module: cursor-typing). While a take records, a global shortcut arms
 * typing finalized live lines into the field focused in another app. Main owns the typer and the
 * shortcut; pages draw the status they receive and can toggle.
 */

const empty = z.object({}).strict();

export const cursorTypingSourceSchema = z.enum(['others', 'all']);

const pausedReasonSchema = z.enum(['focus-changed', 'own-window', 'blocked', 'interrupted']);
const warningSchema = z.enum(['speaker-unknown']).nullable();

/** Mirrors `CursorTypingState` of the core typer. */
export const cursorTypingStateSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('off') }),
  z.object({
    status: z.literal('armed'),
    source: cursorTypingSourceSchema,
    processName: z.string().nullable(),
    warning: warningSchema,
  }),
  z.object({
    status: z.literal('paused'),
    source: cursorTypingSourceSchema,
    processName: z.string().nullable(),
    reason: pausedReasonSchema,
    warning: warningSchema,
  }),
]);
export type CursorTypingStateDto = z.infer<typeof cursorTypingStateSchema>;

/**
 * Why a toggle armed nothing: the typer's refusals (`no-target`, `own-window`, `blocked`) and
 * `inactive`, when nothing records or the feature is off in Settings.
 */
export const cursorTypingRefusalSchema = z.enum(['no-target', 'own-window', 'blocked', 'inactive']);
export type CursorTypingRefusalDto = z.infer<typeof cursorTypingRefusalSchema>;

/**
 * `inactive`: not held (nothing records, or the feature is off). `registered`: the combination is
 * ours while the take records. `unavailable`: Windows refused it (another app owns it) or the
 * accelerator is not valid.
 */
export const cursorTypingShortcutStatusSchema = z.enum(['inactive', 'registered', 'unavailable']);

export const cursorTypingStatusSchema = z.object({
  state: cursorTypingStateSchema,
  shortcut: z.object({
    status: cursorTypingShortcutStatusSchema,
    /** The resolved accelerator from Settings, held or not. */
    accelerator: z.string(),
  }),
  /** The last toggle that armed nothing; cleared by the next arm, a disarm or a new take. */
  lastRefusal: cursorTypingRefusalSchema.nullable(),
  /**
   * Counts every toggle that armed nothing and never goes back, so a second press with the same
   * refusal still changes the status and the page answers it again. Main always sends it; a
   * status without it counts as no refusal seen.
   */
  refusalSeq: z.number().int().nonnegative().optional(),
});
export type CursorTypingStatusDto = z.infer<typeof cursorTypingStatusSchema>;

export const cursorTypingArmResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), reason: cursorTypingRefusalSchema }),
]);

export const cursorTypingGetState = defineRequest('cursorTyping.getState', {
  input: empty,
  output: cursorTypingStatusSchema,
});

/**
 * The same as the shortcut: arms when off, disarms otherwise. `arm` is null when it disarmed.
 * Invoked from a Vozella window, Vozella is the foreground app, so arming is refused with
 * `own-window`; it serves the pill, tests and the fake native build.
 */
export const cursorTypingToggle = defineRequest('cursorTyping.toggle', {
  input: empty,
  output: z.object({
    arm: cursorTypingArmResultSchema.nullable(),
    status: cursorTypingStatusSchema,
  }),
});

/** Every change of the typer state, the shortcut status or the last refusal. */
export const cursorTypingStateChanged = defineEvent('cursorTyping.state', {
  payload: cursorTypingStatusSchema,
});
