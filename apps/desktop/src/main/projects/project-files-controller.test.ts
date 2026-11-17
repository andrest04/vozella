import { projectsChanged } from '@vozella/contracts';
import { InMemoryProjectFileStore, type Logger } from '@vozella/core';
import { describe, expect, it, vi } from 'vitest';
import type { Broadcast } from '../ipc/library-handlers';
import { ProjectFilesController } from './project-files-controller';

const PROJECT = '9f1c0000-0000-4000-8000-000000000001';
const logger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

function setup(
  dialog: { canceled: boolean; filePaths: string[] } = { canceled: false, filePaths: [] },
) {
  const files = new InMemoryProjectFileStore();
  for (const [path, text] of [
    ['C:/a.txt', 'alpha'],
    ['C:/b.txt', 'beta'],
  ] as const) {
    files.registerSource(path, { name: path.slice(3), kind: 'text', sizeBytes: text.length, text });
  }
  const events: { name: string; payload: unknown }[] = [];
  const open = vi.fn(() => Promise.resolve(dialog));
  const broadcast = ((channel, payload) => {
    events.push({ name: channel.name, payload });
  }) as Broadcast;
  const controller = new ProjectFilesController({
    files: () => files,
    dialogs: { showOpenDialog: open as never },
    broadcast,
    logger: logger(),
    filterName: 'Documents',
  });
  return { controller, files, events, open };
}

describe('ProjectFilesController.pick', () => {
  it('opens the picker without image types and adds what was chosen', async () => {
    const { controller, open, events } = setup({ canceled: false, filePaths: ['C:/a.txt'] });
    const { results } = await controller.pick(PROJECT);
    expect(results).toMatchObject([{ ok: true, file: { name: 'a.txt' } }]);
    const options = (
      open.mock.calls[0] as unknown as [
        { properties: string[]; filters: { name: string; extensions: string[] }[] },
      ]
    )[0];
    expect(options.properties).toEqual(['openFile', 'multiSelections']);
    expect(options.filters[0]?.name).toBe('Documents');
    expect(options.filters[0]?.extensions).toEqual(
      expect.arrayContaining(['pdf', 'docx', 'pptx', 'md', 'txt', 'csv']),
    );
    expect(options.filters[0]?.extensions).not.toContain('png');
    expect(events).toEqual([
      { name: projectsChanged.name, payload: { reason: 'files', projectId: PROJECT } },
    ]);
  });

  it('answers an empty list and broadcasts nothing when the user cancels', async () => {
    const { controller, events } = setup({ canceled: true, filePaths: [] });
    expect(await controller.pick(PROJECT)).toEqual({ results: [] });
    expect(events).toEqual([]);
  });
});

describe('ProjectFilesController.add', () => {
  it('adds each path, keeps a bad one from stopping the others and broadcasts once', async () => {
    const { controller, events } = setup();
    const { results } = await controller.add(PROJECT, ['C:/a.txt', 'C:/missing.txt', 'C:/b.txt']);
    expect(results.map((r) => r.ok)).toEqual([true, false, true]);
    expect(results[1]).toMatchObject({ ok: false, reason: 'not-found' });
    expect(events).toHaveLength(1);
  });

  it('ignores a repeated path and caps the batch at ten', async () => {
    const { controller, files } = setup();
    expect((await controller.add(PROJECT, ['C:/a.txt', 'C:/a.txt'])).results).toHaveLength(1);
    const many = Array.from({ length: 14 }, (_, i) => `C:/none-${String(i)}.txt`);
    expect((await controller.add(PROJECT, many)).results).toHaveLength(10);
    expect(await files.list(PROJECT)).toHaveLength(1);
  });

  it('does not broadcast when nothing was added', async () => {
    const { controller, events } = setup();
    await controller.add(PROJECT, ['C:/missing.txt']);
    expect(events).toEqual([]);
  });

  it('answers unreadable when the store throws', async () => {
    const { controller, files } = setup();
    vi.spyOn(files, 'add').mockRejectedValue(new Error('boom'));
    expect((await controller.add(PROJECT, ['C:/a.txt'])).results).toEqual([
      { ok: false, name: 'a.txt', reason: 'unreadable' },
    ]);
  });
});

describe('ProjectFilesController.remove', () => {
  it('removes a file and broadcasts', async () => {
    const { controller, files, events } = setup();
    const added = await files.add(PROJECT, 'C:/a.txt');
    if (!added.ok) throw new Error('add failed');
    expect(await controller.remove(PROJECT, added.file.id)).toEqual({ removed: true });
    expect(events).toHaveLength(1);
  });

  it('answers false and stays quiet for an unknown file or a failing store', async () => {
    const { controller, files, events } = setup();
    expect(await controller.remove(PROJECT, 'nope')).toEqual({ removed: false });
    vi.spyOn(files, 'remove').mockRejectedValue(new Error('boom'));
    expect(await controller.remove(PROJECT, 'x')).toEqual({ removed: false });
    expect(events).toEqual([]);
  });
});
