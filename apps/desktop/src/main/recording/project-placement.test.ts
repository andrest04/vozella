import path from 'node:path';
import {
  InMemoryProjectRepository,
  InMemoryStorageState,
  type ProjectRepository,
} from '@vozella/core';
import { describe, expect, it } from 'vitest';
import { createProjectPlacement } from './project-placement';

const ROOT = '/lib';

async function setup() {
  const state = new InMemoryStorageState();
  const repo = new InMemoryProjectRepository({ state, libraryRoot: ROOT });
  const created = await repo.create({ name: 'Clients', description: '' });
  if (!created.ok) throw new Error('fixture');
  return { state, repo, id: created.value.id };
}

describe('createProjectPlacement', () => {
  it('places a take of a known project in its directory', async () => {
    const { repo, id } = await setup();
    const placement = createProjectPlacement(repo, () => ROOT);
    expect(await placement.resolveProject(id)).toBe(id);
    expect(await placement.audioDirectory(id)).toBe(`${ROOT}/Clients`);
  });

  it('places a take without a project in the Inbox', async () => {
    const { repo } = await setup();
    const placement = createProjectPlacement(repo, () => ROOT);
    expect(await placement.resolveProject(null)).toBeNull();
    expect(await placement.audioDirectory(null)).toBe(`${ROOT}/Inbox`);
  });

  it('a project deleted meanwhile falls back to the Inbox with no project', async () => {
    const { repo, id } = await setup();
    const placement = createProjectPlacement(repo, () => ROOT);
    await repo.delete(id);
    expect(await placement.resolveProject(id)).toBeNull();
    expect(await placement.audioDirectory(id)).toBe(`${ROOT}/Inbox`);
  });

  it('an unreadable project (its directory answers the Inbox) falls back with no project', async () => {
    const { repo, id } = await setup();
    const unsafe: ProjectRepository = {
      state: () => repo.state(),
      list: () => repo.list(),
      get: (projectId) => repo.get(projectId),
      create: (input) => repo.create(input),
      update: (projectId, patch) => repo.update(projectId, patch),
      delete: (projectId) => repo.delete(projectId),
      // Like a skipped project: reads answer the Inbox.
      directoryOf: () => repo.directoryOf(null),
    };
    const placement = createProjectPlacement(unsafe, () => ROOT);
    expect(await placement.resolveProject(id)).toBeNull();
    expect(await placement.audioDirectory(id)).toBe(`${ROOT}/Inbox`);
  });

  it('a storage that is not ready files the take in the Inbox under the library root', async () => {
    const { repo, state, id } = await setup();
    state.set({ status: 'migrating' });
    const placement = createProjectPlacement(repo, () => ROOT);
    expect(await placement.resolveProject(id)).toBeNull();
    expect(await placement.audioDirectory(id)).toBe(path.join(ROOT, 'Inbox'));
  });

  it('a failing repository files the take in the Inbox and never throws', async () => {
    const { id } = await setup();
    const fail = (): Promise<never> => Promise.reject(new Error('disk'));
    const broken = { get: fail, directoryOf: fail };
    const placement = createProjectPlacement(broken, () => ROOT);
    expect(await placement.resolveProject(id)).toBeNull();
    expect(await placement.audioDirectory(id)).toBe(path.join(ROOT, 'Inbox'));
  });
});
