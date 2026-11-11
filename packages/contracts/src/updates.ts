import { z } from 'zod';
import { defineEvent, defineRequest } from './channel';

/**
 * Automatic updates (module: updates). Packaged builds check GitHub Releases, download in the
 * background and install on quit; the renderer only reads the state and may ask to install now.
 */

const empty = z.object({}).strict();

/** Where the updater is. `version` is always the new version, never the running one. */
export const updateStatusSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('idle') }),
  z.object({ status: z.literal('available'), version: z.string() }),
  z.object({
    status: z.literal('downloading'),
    version: z.string(),
    percent: z.number().min(0).max(100),
  }),
  z.object({ status: z.literal('ready'), version: z.string() }),
  z.object({ status: z.literal('error'), message: z.string() }),
]);
export type UpdateStatus = z.infer<typeof updateStatusSchema>;

/** The running version travels with the status, so the renderer can show "a → b". */
export const updateStateSchema = z.object({
  currentVersion: z.string(),
  update: updateStatusSchema,
});
export type UpdateState = z.infer<typeof updateStateSchema>;

export const updatesGetState = defineRequest('updates.getState', {
  input: empty,
  output: updateStateSchema,
});

/**
 * Asks the exit gates (a recording refuses), then quits and runs the downloaded installer, which
 * starts the app again. `failed` covers "no update is ready" and an installer that would not start.
 */
export const updatesInstall = defineRequest('updates.install', {
  input: empty,
  output: z.discriminatedUnion('status', [
    z.object({ status: z.literal('restarting') }),
    z.object({ status: z.literal('refused') }),
    z.object({ status: z.literal('failed'), message: z.string() }),
  ]),
});
export type UpdateInstallOutcome = z.infer<typeof updatesInstall.output>;

/** Pushed whenever the status changes. */
export const updatesStateChanged = defineEvent('updates.stateChanged', {
  payload: updateStateSchema,
});
