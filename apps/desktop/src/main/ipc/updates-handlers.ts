import { updatesGetState, updatesInstall } from '@vozella/contracts';
import type { UpdatesService } from '../updates/update-controller';
import { registerRequest, type IpcServerDeps } from './ipc-server';

export interface UpdatesHandlerDeps {
  readonly server: IpcServerDeps;
  readonly updates: UpdatesService;
}

/** Wires the update channels. The state pushes go through `updates.stateChanged` from compose. */
export function registerUpdatesHandlers(deps: UpdatesHandlerDeps): void {
  registerRequest(deps.server, updatesGetState, () => deps.updates.state());
  registerRequest(deps.server, updatesInstall, () => deps.updates.install());
}
