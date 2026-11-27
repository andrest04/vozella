import { cursorTypingGetState, cursorTypingToggle } from '@vozella/contracts';
import type { CursorTypingController } from '../cursor-typing/cursor-typing-controller';
import { registerRequest, type IpcServerDeps } from './ipc-server';

export type CursorTypingService = Pick<CursorTypingController, 'status' | 'toggle'>;

export interface CursorTypingHandlerDeps {
  readonly server: IpcServerDeps;
  readonly controller: CursorTypingService;
}

/** Wires the type at cursor channels. State pushes go through `cursorTyping.state` from the controller. */
export function registerCursorTypingHandlers({
  server,
  controller,
}: CursorTypingHandlerDeps): void {
  registerRequest(server, cursorTypingGetState, () => controller.status());
  // Same as the shortcut. From a Vozella window the arm is refused with `own-window`.
  registerRequest(server, cursorTypingToggle, () => {
    const arm = controller.toggle();
    return { arm, status: controller.status() };
  });
}
