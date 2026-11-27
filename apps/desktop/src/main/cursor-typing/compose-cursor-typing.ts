import type { Logger, SettingsStore, TextInjectorPort } from '@vozella/core';
import { FakeTextInjector } from '@vozella/platform';
import type { Broadcast } from '../ipc/library-handlers';
import { registerCursorTypingHandlers } from '../ipc/cursor-typing-handlers';
import type { IpcServerDeps } from '../ipc/ipc-server';
import type { TranscriptionController } from '../transcription/transcription-controller';
import { CursorTypingController, type ShortcutRegistry } from './cursor-typing-controller';

export interface ComposeCursorTypingDeps {
  readonly fakeNative: boolean;
  /** The native injector; throws when the addon or its exports cannot be loaded. */
  readonly loadInjector: () => TextInjectorPort;
  readonly transcription: Pick<TranscriptionController, 'onLiveUpdate' | 'liveMicDominantShare'>;
  readonly settings: Pick<SettingsStore, 'load'>;
  /** Electron's `globalShortcut` in the app. */
  readonly shortcuts: ShortcutRegistry;
  readonly broadcast: Broadcast;
  /** Already scoped (`logger.child('cursor-typing')`). */
  readonly logger: Logger;
  readonly server: IpcServerDeps;
  readonly stopOnExit: (stop: () => void) => void;
}

export interface ComposedCursorTyping {
  readonly controller: CursorTypingController;
  /** The fake in the fake native build, so e2e tests can read what was typed. */
  readonly injector: TextInjectorPort;
}

/** Without the addon there is no foreground window to type into: every arm is refused. */
const unavailableInjector: TextInjectorPort = {
  foregroundTarget: () => null,
  typeText: (text) => ({ sent: 0, expected: text.length * 2 }),
};

function injectorFor(deps: ComposeCursorTypingDeps): TextInjectorPort {
  if (deps.fakeNative) return new FakeTextInjector();
  try {
    return deps.loadInjector();
  } catch (error) {
    deps.logger.warn('text injector unavailable; type at cursor cannot arm', {
      error: error instanceof Error ? error.message : String(error),
    });
    return unavailableInjector;
  }
}

/** Type at cursor: the controller, its IPC handlers, its settings read and its quit cleanup. */
export function composeCursorTyping(deps: ComposeCursorTypingDeps): ComposedCursorTyping {
  const injector = injectorFor(deps);
  const controller = new CursorTypingController({
    injector,
    micDominantShare: (startMs, endMs) => deps.transcription.liveMicDominantShare(startMs, endMs),
    onLiveUpdate: (listener) => deps.transcription.onLiveUpdate(listener),
    settings: deps.settings,
    shortcuts: deps.shortcuts,
    broadcast: deps.broadcast,
    logger: deps.logger,
  });
  registerCursorTypingHandlers({ server: deps.server, controller });
  refreshCursorTypingSettings(controller, deps.logger);
  deps.stopOnExit(() => {
    controller.dispose();
  });
  return { controller, injector };
}

/** Reads the settings into the controller; a failed read keeps the previous ones. */
export function refreshCursorTypingSettings(
  controller: Pick<CursorTypingController, 'refreshSettings'>,
  logger: Pick<Logger, 'warn'>,
): void {
  controller.refreshSettings().catch((error: unknown) => {
    logger.warn('could not read the type at cursor settings', { error: String(error) });
  });
}

/** True when a saved settings patch names a type at cursor setting. */
export const changesCursorTyping = (patch: Readonly<Record<string, unknown>>): boolean =>
  Object.keys(patch).some((key) => key.startsWith('cursorTyping'));
