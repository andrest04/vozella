// @vitest-environment jsdom
import { act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { guid, projectItem } from '../../test-support/project-fixtures';
import { installVozella, uninstallVozella } from '../../test-support/vozella-mock';
import { connectProjectDirectory, useProjectDirectory } from './project-directory';

afterEach(() => {
  uninstallVozella();
  vi.useRealTimers();
});

const list = (names: string[]) => ({
  projects: names.map((name, index) => projectItem(index + 1, name)),
  noProject: { meetingCount: 2, lastActivityAt: '2026-09-04T10:00:00.000Z' },
  skipped: [],
  storage: { status: 'ready' as const },
});

describe('project directory', () => {
  it('loads the projects when connected and clears them when the last one disconnects', async () => {
    const mock = installVozella({ 'projects.list': () => list(['Alpha', 'Beta']) });
    const off = connectProjectDirectory();
    await vi.waitFor(() => {
      expect(useProjectDirectory.getState().status).toBe('ready');
    });
    expect(useProjectDirectory.getState().projects.map((p) => p.name)).toEqual(['Alpha', 'Beta']);
    expect(useProjectDirectory.getState().noProject.meetingCount).toBe(2);
    expect(mock.listenerCount('projects.changed')).toBe(1);
    off();
    expect(mock.listenerCount('projects.changed')).toBe(0);
    expect(useProjectDirectory.getState().status).toBe('loading');
  });

  it('shares one subscription between connections', async () => {
    const mock = installVozella({ 'projects.list': () => list(['Alpha']) });
    const first = connectProjectDirectory();
    const second = connectProjectDirectory();
    expect(mock.listenerCount('projects.changed')).toBe(1);
    first();
    expect(mock.listenerCount('projects.changed')).toBe(1);
    second();
    expect(mock.listenerCount('projects.changed')).toBe(0);
  });

  it('reloads when projects.changed or library.changed arrives, once per burst', async () => {
    vi.useFakeTimers();
    let names = ['Alpha'];
    const mock = installVozella({ 'projects.list': () => list(names) });
    const off = connectProjectDirectory();
    await vi.advanceTimersByTimeAsync(0);
    expect(useProjectDirectory.getState().projects).toHaveLength(1);
    names = ['Alpha', 'Beta'];
    act(() => {
      mock.emit('projects.changed', { reason: 'project', projectId: guid(2) });
      mock.emit('library.changed', { reason: 'meeting' });
    });
    await vi.advanceTimersByTimeAsync(300);
    expect(useProjectDirectory.getState().projects).toHaveLength(2);
    expect(mock.inputsOf('projects.list')).toHaveLength(2);
    off();
  });

  it('marks a failed load and keeps the last projects', async () => {
    const mock = installVozella({ 'projects.list': () => list(['Alpha']) });
    const off = connectProjectDirectory();
    await vi.waitFor(() => {
      expect(useProjectDirectory.getState().status).toBe('ready');
    });
    mock.handle('projects.list', () => {
      throw new Error('boom');
    });
    act(() => {
      mock.emit('projects.changed', { reason: 'project', projectId: null });
    });
    await vi.waitFor(() => {
      expect(useProjectDirectory.getState().status).toBe('failed');
    });
    expect(useProjectDirectory.getState().projects).toHaveLength(1);
    off();
  });
});
