import { Workspace } from '@vozella/core';
import { describe, expect, it, vi } from 'vitest';
import {
  inMemoryProjectLibrary,
  noDialogs,
  recordingIpc,
  requestChannelsWithPrefix,
  silentLogger,
} from '../compose-test-kit';
import { composeProjects } from './compose-projects';

function compose() {
  const { server, channels } = recordingIpc();
  composeProjects({
    library: inMemoryProjectLibrary(),
    workspace: new Workspace(),
    broadcast: vi.fn(),
    server,
    dialogs: noDialogs(),
    logger: silentLogger(),
  });
  return { channels };
}

describe('composeProjects', () => {
  it('registers every project and project file request channel once', () => {
    const { channels } = compose();
    expect([...channels].sort()).toEqual(requestChannelsWithPrefix('projects.'));
  });
});
