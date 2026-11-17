import { InMemoryProjectFileStore, InMemoryProjectRepository } from '@vozella/core';
import { describe, expect, it } from 'vitest';
import { createProjectContextSource } from './project-context-source';

async function fixture() {
  const projects = new InMemoryProjectRepository();
  const files = new InMemoryProjectFileStore();
  const created = await projects.create({ name: 'Calculus' });
  if (!created.ok) throw new Error('create failed');
  await projects.update(created.value.id, { instructions: 'Answer in Spanish.' });
  files.registerSource('/src/syllabus.txt', {
    name: 'syllabus.txt',
    kind: 'text',
    sizeBytes: 12,
    text: 'Week 1: limits',
  });
  return { source: createProjectContextSource({ projects, files }), files, id: created.value.id };
}

describe('createProjectContextSource', () => {
  it('is null for an unknown project', async () => {
    const { source } = await fixture();
    expect(await source.get('00000000-0000-4000-8000-0000000000ff')).toBeNull();
  });

  it('serves the name, the instructions and the documents of a known project', async () => {
    const { source, files, id } = await fixture();
    await files.add(id, '/src/syllabus.txt');
    const data = await source.get(id);
    expect(data).toMatchObject({
      projectId: id,
      name: 'Calculus',
      instructions: 'Answer in Spanish.',
    });
    expect(data?.documents.map((d) => d.name)).toEqual(['syllabus.txt']);
  });

  it('serves an empty document list for a project without files', async () => {
    const { source, id } = await fixture();
    expect((await source.get(id))?.documents).toEqual([]);
  });
});
