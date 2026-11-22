import { z } from 'zod';
import { defineEvent, defineRequest } from './channel';

/**
 * Automatic updates (module: updates). Packaged builds check GitHub Releases, download in the
 * background and install on quit; the renderer reads the state, may ask for a check now, and may
 * ask to install now.
 */

const empty = z.object({}).strict();

/** Where the updater is. `version` is always the new version, never the running one. */
export const updateStatusSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('idle') }),
  z.object({ status: z.literal('checking') }),
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

/**
 * The running version travels with the status, so the renderer can show "a → b". `lastCheckedAt`
 * (epoch ms) is when the feed last answered; it is absent until the first answer.
 */
export const updateStateSchema = z.object({
  currentVersion: z.string(),
  update: updateStatusSchema,
  lastCheckedAt: z.number().int().nonnegative().optional(),
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

/**
 * Checks the feed now. The result arrives through `updates.stateChanged`; this answer only says
 * whether a check started. `busy`: a check or a download is already running. `ready`: an update is
 * downloaded and waits for install. `disabled`: this build never updates (dev, e2e, fake native).
 */
export const updatesCheck = defineRequest('updates.check', {
  input: empty,
  output: z.discriminatedUnion('status', [
    z.object({ status: z.literal('started') }),
    z.object({ status: z.literal('busy') }),
    z.object({ status: z.literal('ready') }),
    z.object({ status: z.literal('disabled') }),
  ]),
});
export type UpdateCheckOutcome = z.infer<typeof updatesCheck.output>;

/** Pushed whenever the status changes. */
export const updatesStateChanged = defineEvent('updates.stateChanged', {
  payload: updateStateSchema,
});
