import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CancelSource,
  createStorageLayout,
  InMemoryProjectRepository,
  InMemorySettingsStore,
  SummaryService,
  type JevAnalysis,
  type MeetingRecord,
  type SummaryProvider,
} from '@vozella/core';
import { extractDocument } from '../chat/attachment-extractors';
import { createLibraryFixture, type LibraryFixture } from '../library/library-test-kit';
import { createProjectContextSource } from '../projects/project-context-source';
import { createProjectFileStore } from '../projects/project-file-store';
import { StorageStateHolder } from '../projects/storage-state';

/** Item 112 and 4.2: a generate on files written by the WinUI app keeps every other field. */
const source = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'library',
  'fixtures',
  'winui-library',
);
const WEEKLY = '3f2b8c1e-9a47-4d0e-b1c2-5e6f7a8b9c0d';

let fx: LibraryFixture;
beforeEach(() => {
  fx = createLibraryFixture();
  fs.cpSync(source, fx.root, { recursive: true });
  fs.rmSync(path.join(fx.root, '.gitattributes'));
  fs.renameSync(path.join(fx.root, 'folders.json.fixture'), path.join(fx.root, 'folders.json'));
});
afterEach(() => {
  fx.cleanup();
});

const provider: SummaryProvider = {
  id: 'codex',
  summarize: () =>
    Promise.resolve({
      summaryMarkdown: '### Fresh\nNew text',
      actionItems: [{ text: 'Call Ana', isDone: false }],
      providerId: 'codex' as const,
      suggestedTitle: 'Ignored for a real title',
    }),
} as unknown as SummaryProvider;

const service = (notified: string[]) =>
  new SummaryService({
    meetings: fx.meetings,
    settings: new InMemorySettingsStore(),
    resolver: {
      resolveSummaryProvider: () => Promise.resolve({ status: 'ready', kind: 'Codex', provider }),
    },
    clock: { now: () => new Date('2026-09-05T15:00:00.000Z') },
    notifyMeetingChanged: (id) => notified.push(id),
  });

const generate = (s: SummaryService, id: string, templateId?: string | null) =>
  s.generate({
    meetingId: id,
    regenerate: true,
    cancel: new CancelSource().signal,
    ...(templateId === undefined ? {} : { templateId }),
  });

describe('SummaryService over the Markdown repository', () => {
  it('rewrites Summary and Action Items, keeps the other sections and the folder', async () => {
    const notified: string[] = [];
    const outcome = await generate(service(notified), WEEKLY, 'standup');
    expect(outcome).toMatchObject({ status: 'generated', titleChanged: false });
    expect(notified).toEqual([]);

    const files = fs.readdirSync(path.join(fx.root, 'Universidad', 'Cálculo'));
    expect(files).toEqual(['2026-09-01 Weekly sync planning.md']);
    const text = fs.readFileSync(path.join(fx.root, 'Universidad', 'Cálculo', files[0]!), 'utf8');
    expect(text).toContain('summaryProvider: codex');
    expect(text).toContain('noteTemplateId: standup');
    expect(text).toContain('## Summary\n\n### Fresh\nNew text');
    expect(text).toContain('- [ ] Call Ana');
    expect(text).not.toContain('Follow up with Luis');
    expect(text).toContain('## Brief\n\nTwo open questions.');
    expect(text).toContain('[00:00:03] Ana: Hello everyone.');
    expect(text).toContain('Remember the exam date.');
    expect(text).toContain('Subject: recap');
    expect(text).toContain('### Steps\nShip');

    const back = await fx.meetings.get(WEEKLY);
    expect(back).toMatchObject({
      projectId: '8e2f1b63-44d5-4a7c-9ba1-1d2e3f4a5b6c',
      joinUrl: 'https://teams.microsoft.com/l/meetup-join/abc',
      attendees: ['Ana Perez', 'Luis Gomez'],
    });
  });

  it('keeps Jev frontmatter, event keys and the Brief for a record that has them', async () => {
    const jev: JevAnalysis = {
      meetingType: 'planning',
      meetingTypeConfidence: 0.8,
      spokenLanguage: 'en',
      urgencyScore: 2,
      urgencyConfidence: 0.5,
      containsDecisions: 1,
      containsCommitments: 1,
      piiRisk: 0,
      summaryFaithful: 0.9,
      suggestedFolderId: null,
      folderConfidence: null,
      actionItems: [{ text: 'Old', relation: 'new', confidence: 0.4 }],
      model: 'jev-1',
      analyzedAt: '2026-09-01T14:00:00.0000000-05:00',
    };
    const base = (await fx.meetings.get(WEEKLY))!;
    const rich: MeetingRecord = {
      ...base,
      calendarEventId: 'evt-9',
      calendarId: 'cal-9',
      seriesId: 'series-9',
      jevAnalysis: jev,
      noteTemplateId: 'custom',
    };
    await fx.meetings.save(rich);
    const before = (await fx.meetings.get(WEEKLY))!;
    expect(before.jevAnalysis).toMatchObject({ meetingType: 'planning', model: 'jev-1' });

    await generate(service([]), WEEKLY);
    const after = (await fx.meetings.get(WEEKLY))!;
    expect(after).toEqual({
      ...before,
      summary: '### Fresh\nNew text',
      actionItems: [{ text: 'Call Ana', isDone: false }],
      summaryProvider: 'codex',
      noteTemplateId: null,
      sourcePath: after.sourcePath,
    });
    expect(after.calendarEventId).toBe('evt-9');
    expect(after.brief).toBe('Two open questions.');
  });
});

describe('SummaryService with the project context', () => {
  const PROJECT = '8e2f1b63-44d5-4a7c-9ba1-1d2e3f4a5b6c';

  it('hands the provider the instructions and the stored files of the meeting project', async () => {
    const layout = createStorageLayout(fx.root, path);
    fs.mkdirSync(layout.projectDirectory(PROJECT), { recursive: true });
    fs.writeFileSync(layout.projectJsonFile(PROJECT), '{}');
    const state = new StorageStateHolder({ status: 'ready' });
    const files = createProjectFileStore({
      layout,
      extractor: extractDocument,
      state,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      clock: { now: () => new Date('2026-11-16T10:00:00.000Z') },
      newId: () => 'aaaaaaaa-0000-4000-8000-000000000001',
    });
    const brief = path.join(fx.dir, 'Syllabus.md');
    fs.writeFileSync(brief, 'The final exam covers limits and derivatives.');
    expect(await files.add(PROJECT, brief)).toMatchObject({ ok: true });
    const projects = new InMemoryProjectRepository();
    projects.records.set(PROJECT, {
      id: PROJECT,
      name: 'Calculo',
      description: '',
      instructions: 'Answer in Spanish.',
      pinned: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const seen: unknown[] = [];
    const spy = {
      id: 'codex',
      summarize: (request: { enhancement?: unknown }) => {
        seen.push(request.enhancement);
        return provider.summarize(request as never, new CancelSource().signal);
      },
    } as unknown as SummaryProvider;
    const withContext = new SummaryService({
      meetings: fx.meetings,
      settings: new InMemorySettingsStore(),
      resolver: {
        resolveSummaryProvider: () =>
          Promise.resolve({ status: 'ready', kind: 'Codex', provider: spy }),
      },
      clock: { now: () => new Date('2026-09-05T15:00:00.000Z') },
      notifyMeetingChanged: () => undefined,
      projectContext: createProjectContextSource({ projects, files }),
    });
    expect(await generate(withContext, WEEKLY)).toMatchObject({ status: 'generated' });
    expect(seen[0]).toMatchObject({
      projectInstructions: 'Answer in Spanish.',
    });
    expect((seen[0] as { projectFiles: string }).projectFiles).toContain(
      'The final exam covers limits and derivatives.',
    );
  });
});
