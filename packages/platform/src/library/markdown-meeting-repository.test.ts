import fs from 'node:fs';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MeetingTrashError, renderMeetingMarkdown } from '@vozella/core';
import { MarkdownMeetingRepository } from './markdown-meeting-repository';
import {
  FOLDER_1,
  FOLDER_2,
  ID_A,
  ID_B,
  createLibraryFixture,
  meeting,
  tree,
  type LibraryFixture,
} from './library-test-kit';

let fx: LibraryFixture;
beforeEach(() => {
  fx = createLibraryFixture();
});
afterEach(() => {
  vi.restoreAllMocks();
  fx.cleanup();
});

const write = (rel: string, text: string): string => {
  const full = path.join(fx.root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
  return full;
};

describe('save and read', () => {
  it('writes only inside the injected root', async () => {
    await fx.meetings.save(meeting());
    expect(tree(fx.root)).toEqual(['Inbox/2026-09-01 Standup.md']);
    expect(fs.readdirSync(fx.dir).sort()).toEqual(['app', 'library']);
  });

  it('round-trips a meeting and sets sourcePath', async () => {
    const saved = await fx.meetings.save(
      meeting({ summary: '## Decisions\nShip it', notes: 'n', projectId: null }),
    );
    expect(saved.sourcePath).toBe(path.join(fx.root, 'Inbox', '2026-09-01 Standup.md'));
    expect(await fx.meetings.get(ID_A)).toEqual(saved);
  });

  it('files a meeting in its project directory, and an unknown project in Inbox', async () => {
    fx.projects.add(FOLDER_1, 'Universidad');
    fx.projects.add(FOLDER_2, 'Universidad/Calculo');
    await fx.meetings.save(meeting({ projectId: FOLDER_2 }));
    await fx.meetings.save(
      meeting({ id: ID_B, title: 'Lost', projectId: 'deadbeef-0000-0000-0000-000000000000' }),
    );
    expect(tree(fx.root)).toEqual([
      'Inbox/2026-09-01 Lost.md',
      'Universidad/Calculo/2026-09-01 Standup.md',
    ]);
  });

  it('adds a numeric suffix for a different meeting with the same stem', async () => {
    await fx.meetings.save(meeting());
    await fx.meetings.save(meeting({ id: ID_B }));
    expect(tree(fx.root)).toEqual(['Inbox/2026-09-01 Standup 2.md', 'Inbox/2026-09-01 Standup.md']);
  });

  it('saving the same meeting again reuses its file', async () => {
    await fx.meetings.save(meeting());
    await fx.meetings.save(meeting({ summary: 'changed' }));
    expect(tree(fx.root)).toEqual(['Inbox/2026-09-01 Standup.md']);
    expect((await fx.meetings.get(ID_A))?.summary).toBe('changed');
  });

  it('get returns null for an unknown id', async () => {
    expect(await fx.meetings.get(ID_B)).toBeNull();
  });

  it('writes LF without a BOM', async () => {
    const saved = await fx.meetings.save(meeting());
    const bytes = fs.readFileSync(saved.sourcePath ?? '');
    expect(bytes[0]).toBe(0x2d);
    expect(bytes.includes(0x0d)).toBe(false);
  });
});

describe('moving and renaming', () => {
  it('changing the project moves the markdown and the wav together and updates audioFilePath', async () => {
    fx.projects.add(FOLDER_1, 'Universidad');
    const first = await fx.meetings.save(meeting());
    const wav = first.sourcePath?.replace(/\.md$/, '.wav') ?? '';
    fs.writeFileSync(wav, 'RIFF');
    const withAudio = await fx.meetings.save({ ...first, audioFilePath: wav });
    expect(withAudio.audioFilePath).toBe(wav);

    const moved = await fx.meetings.save({ ...withAudio, projectId: FOLDER_1 });
    expect(tree(fx.root)).toEqual([
      'Universidad/2026-09-01 Standup.md',
      'Universidad/2026-09-01 Standup.wav',
    ]);
    expect(moved.audioFilePath).toBe(path.join(fx.root, 'Universidad', '2026-09-01 Standup.wav'));
    expect(moved.projectId).toBe(FOLDER_1);
    expect((await fx.meetings.get(ID_A))?.audioFilePath).toBe(moved.audioFilePath);
  });

  it('a new title renames the files', async () => {
    const first = await fx.meetings.save(meeting());
    await fx.meetings.save({ ...first, title: 'Retro' });
    expect(tree(fx.root)).toEqual(['Inbox/2026-09-01 Retro.md']);
  });

  it('B2: a recording already sitting at the stem does not force a " 2" suffix', async () => {
    // The recorder creates the wav first, then the first save writes the markdown.
    const wav = path.join(fx.root, 'Inbox', '2026-09-01 Standup.wav');
    fs.mkdirSync(path.dirname(wav), { recursive: true });
    fs.writeFileSync(wav, 'RIFF');
    const saved = await fx.meetings.save(meeting({ audioFilePath: wav }));
    expect(tree(fx.root)).toEqual(['Inbox/2026-09-01 Standup.md', 'Inbox/2026-09-01 Standup.wav']);
    expect(saved.audioFilePath).toBe(wav);
  });

  it('B2: a recording that belongs to someone else still forces a new stem', async () => {
    const wav = path.join(fx.root, 'Inbox', '2026-09-01 Standup.wav');
    fs.mkdirSync(path.dirname(wav), { recursive: true });
    fs.writeFileSync(wav, 'RIFF');
    await fx.meetings.save(meeting());
    expect(tree(fx.root)).toEqual([
      'Inbox/2026-09-01 Standup 2.md',
      'Inbox/2026-09-01 Standup.wav',
    ]);
  });

  it('moves a recording from elsewhere in and replaces a file at the destination', async () => {
    const source = path.join(fx.dir, 'elsewhere.wav');
    fs.writeFileSync(source, 'NEW');
    const saved = await fx.meetings.save(meeting({ audioFilePath: source }));
    expect(fs.existsSync(source)).toBe(false);
    expect(fs.readFileSync(saved.audioFilePath, 'utf8')).toBe('NEW');
  });

  it('a failed wav move leaves the old markdown and the old files untouched', async () => {
    const failing = createLibraryFixture({
      rename: () => Promise.reject(Object.assign(new Error('EBUSY'), { code: 'EBUSY' })),
    });
    try {
      failing.projects.add(FOLDER_1, 'U');
      const first = await failing.meetings.save(meeting());
      const wav = first.sourcePath?.replace(/\.md$/, '.wav') ?? '';
      fs.writeFileSync(wav, 'RIFF');
      await expect(
        failing.meetings.save({ ...first, audioFilePath: wav, projectId: FOLDER_1 }),
      ).rejects.toThrow('EBUSY');
      expect(tree(failing.root)).toEqual([
        'Inbox/2026-09-01 Standup.md',
        'Inbox/2026-09-01 Standup.wav',
      ]);
    } finally {
      failing.cleanup();
    }
  });
});

describe('blank audioFilePath and replacing a destination', () => {
  it('item 53: a blank audioFilePath takes the sibling wav of the existing markdown along', async () => {
    const first = await fx.meetings.save(meeting());
    const wav = (first.sourcePath ?? '').replace(/\.md$/, '.wav');
    fs.writeFileSync(wav, 'RIFF');
    await fx.meetings.save({ ...first, audioFilePath: '', title: 'Retro' });
    expect(tree(fx.root)).toEqual(['Inbox/2026-09-01 Retro.md', 'Inbox/2026-09-01 Retro.wav']);
    fx.projects.add(FOLDER_1, 'Universidad');
    const again = (await fx.meetings.get(ID_A))!;
    await fx.meetings.save({ ...again, audioFilePath: '', projectId: FOLDER_1 });
    expect(tree(fx.root)).toContain('Universidad/2026-09-01 Retro.wav');
    expect(tree(fx.root)).not.toContain('Inbox/2026-09-01 Retro.wav');
  });

  it('item 54: a file already at the destination is replaced by the moved recording', async () => {
    const source = path.join(fx.dir, 'elsewhere.wav');
    fs.writeFileSync(source, 'NEW');
    const destination = path.join(fx.root, 'Inbox', '2026-09-01 Standup.wav');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, 'OLD-OF-ANOTHER');
    // The destination wav belongs to nobody, so the stem is taken and the save allocates " 2".
    const saved = await fx.meetings.save(meeting({ audioFilePath: source }));
    expect(fs.readFileSync(destination, 'utf8')).toBe('OLD-OF-ANOTHER');
    expect(fs.readFileSync(saved.audioFilePath, 'utf8')).toBe('NEW');
    // Re-saving to a stem whose wav is the meeting's own, with a different source, replaces it.
    const other = path.join(fx.dir, 'newer.wav');
    fs.writeFileSync(other, 'NEWER');
    const again = await fx.meetings.save({ ...saved, audioFilePath: other });
    expect(fs.existsSync(other)).toBe(false);
    expect(fs.readFileSync(again.audioFilePath, 'utf8')).toBe('NEWER');
  });
});

describe('delete', () => {
  it('removes the markdown and the wav', async () => {
    const first = await fx.meetings.save(meeting());
    const wav = first.sourcePath?.replace(/\.md$/, '.wav') ?? '';
    fs.writeFileSync(wav, 'RIFF');
    await fx.meetings.save({ ...first, audioFilePath: wav });
    await fx.meetings.delete(ID_A);
    expect(tree(fx.root)).toEqual([]);
  });

  it('is a no-op for a meeting that is already gone', async () => {
    await expect(fx.meetings.delete(ID_A)).resolves.toBeUndefined();
  });

  it('still removes the markdown when the wav is missing', async () => {
    await fx.meetings.save(meeting({ audioFilePath: path.join(fx.root, 'Inbox', 'gone.wav') }));
    await fx.meetings.delete(ID_A);
    expect(tree(fx.root)).toEqual([]);
  });

  it('a locked wav throws and the meeting stays listed so it can be retried', async () => {
    let locked = true;
    const f = createLibraryFixture({
      unlink: (p) =>
        locked && p.endsWith('.wav')
          ? Promise.reject(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }))
          : fs.promises.unlink(p),
    });
    try {
      const first = await f.meetings.save(meeting());
      const wav = first.sourcePath?.replace(/\.md$/, '.wav') ?? '';
      fs.writeFileSync(wav, 'RIFF');
      await f.meetings.save({ ...first, audioFilePath: wav });
      await expect(f.meetings.delete(ID_A)).rejects.toThrow('EBUSY');
      expect((await f.meetings.list()).items.map((i) => i.id)).toEqual([ID_A]);
      locked = false;
      await f.meetings.delete(ID_A);
      expect(tree(f.root)).toEqual([]);
    } finally {
      f.cleanup();
    }
  });

  describe('with a Recycle Bin', () => {
    const withBin = (discard: (p: string) => Promise<void>) => {
      const unlinked: string[] = [];
      const f = createLibraryFixture({
        discard,
        unlink: (p) => {
          unlinked.push(path.basename(p));
          return fs.promises.unlink(p);
        },
      });
      const save = async () => {
        const first = await f.meetings.save(meeting());
        const wav = first.sourcePath?.replace(/\.md$/, '.wav') ?? '';
        fs.writeFileSync(wav, 'RIFF');
        return f.meetings.save({ ...first, audioFilePath: wav });
      };
      return { f, unlinked, save };
    };

    it('sends the recording and the markdown there, and nothing is unlinked', async () => {
      const discarded: string[] = [];
      const { f, unlinked, save } = withBin((p) => {
        discarded.push(path.basename(p));
        return fs.promises.unlink(p);
      });
      try {
        await save();
        unlinked.length = 0;
        await f.meetings.delete(ID_A);
        expect(discarded).toEqual(['2026-09-01 Standup.wav', '2026-09-01 Standup.md']);
        expect(unlinked).toEqual([]);
        expect(tree(f.root)).toEqual([]);
      } finally {
        f.cleanup();
      }
    });

    it('a refusal is reported as a trash failure and the meeting stays listed', async () => {
      const { f, save } = withBin(() => Promise.reject(new Error('no bin on this volume')));
      try {
        await save();
        await expect(f.meetings.delete(ID_A)).rejects.toBeInstanceOf(MeetingTrashError);
        expect((await f.meetings.list()).items.map((i) => i.id)).toEqual([ID_A]);
      } finally {
        f.cleanup();
      }
    });

    it('a permanent delete unlinks and never asks the Recycle Bin', async () => {
      const discard = vi.fn(() => Promise.reject(new Error('no bin on this volume')));
      const { f, unlinked, save } = withBin(discard);
      try {
        await save();
        unlinked.length = 0;
        await f.meetings.delete(ID_A, 'permanent');
        expect(discard).not.toHaveBeenCalled();
        expect(unlinked).toEqual(['2026-09-01 Standup.wav', '2026-09-01 Standup.md']);
      } finally {
        f.cleanup();
      }
    });

    it('moving a meeting still unlinks its old file: that is not a delete', async () => {
      const discard = vi.fn(() => Promise.resolve());
      const { f, unlinked, save } = withBin(discard);
      try {
        const saved = await save();
        f.projects.add(FOLDER_1, 'Universidad');
        unlinked.length = 0;
        await f.meetings.save({ ...saved, projectId: FOLDER_1 });
        expect(discard).not.toHaveBeenCalled();
        expect(unlinked).toEqual(['2026-09-01 Standup.md']);
      } finally {
        f.cleanup();
      }
    });
  });

  it('does not rewrite sibling meetings', async () => {
    const a = await fx.meetings.save(meeting());
    const b = await fx.meetings.save(meeting({ id: ID_B, title: 'Other' }));
    const before = fs.statSync(b.sourcePath ?? '').mtimeMs;
    await new Promise((r) => setTimeout(r, 15));
    await fx.meetings.delete(ID_A);
    expect(fs.statSync(b.sourcePath ?? '').mtimeMs).toBe(before);
    expect(fs.existsSync(a.sourcePath ?? '')).toBe(false);
  });

  it('B25: a recording outside the library is left in place', async () => {
    const outside = path.join(fx.dir, 'precious.wav');
    fs.writeFileSync(outside, 'RIFF');
    const saved = await fx.meetings.save(meeting());
    // Hand-edit the stored path to point outside the library.
    fs.writeFileSync(
      saved.sourcePath ?? '',
      renderMeetingMarkdown({ ...saved, audioFilePath: outside }),
    );
    await fx.meetings.delete(ID_A);
    expect(fs.existsSync(outside)).toBe(true);
    expect(tree(fx.root)).toEqual([]);
  });
});

describe('bodies', () => {
  const collect = async (repository = fx.meetings, filter = (): boolean => true) => {
    const out = [];
    for await (const body of repository.bodies(filter)) out.push(body);
    return out;
  };
  const reads = (root: string) => {
    const spy = vi.spyOn(fsp, 'readFile');
    return {
      count: () =>
        spy.mock.calls.filter(([p]) => typeof p === 'string' && p.startsWith(root)).length,
      restore: () => {
        spy.mockRestore();
      },
    };
  };

  it('gives folded text for every field, and the original on request', async () => {
    await fx.meetings.save(
      meeting({ title: 'Año nuevo', summary: 'RESUMEN', notes: 'Última nota', transcript: 'Dijo' }),
    );
    const [body] = await collect();
    expect(body?.item.id).toBe(ID_A);
    expect(body?.folded).toEqual({
      title: 'ano nuevo',
      summary: 'resumen',
      notes: 'ultima nota',
      transcript: 'dijo',
    });
    expect(await body?.original()).toMatchObject({ title: 'Año nuevo', notes: 'Última nota' });
  });

  it('applies the filter', async () => {
    await fx.meetings.save(meeting());
    await fx.meetings.save(meeting({ id: ID_B, title: 'Second' }));
    const bodies = await collect(
      fx.meetings,
      ((item: { id: string }) => item.id === ID_B) as never,
    );
    expect(bodies.map((b) => b.item.id)).toEqual([ID_B]);
  });

  it('reuses folded text while the file is unchanged, and refolds after an edit', async () => {
    await fx.meetings.save(meeting({ notes: 'Primera' }));
    await collect();
    const seen = reads(fx.root);
    try {
      await collect();
      expect(seen.count()).toBe(0);
    } finally {
      seen.restore();
    }
    const saved = await fx.meetings.get(ID_A);
    if (!saved) throw new Error('missing');
    await fx.meetings.save({ ...saved, notes: 'Cambiada y más larga' });
    const [body] = await collect();
    expect(body?.folded.notes).toBe('cambiada y mas larga');
  });

  it('skips a file that disappears, and original() is null for one that goes later', async () => {
    const saved = await fx.meetings.save(meeting());
    const [body] = await collect();
    fs.unlinkSync(saved.sourcePath ?? '');
    expect(await body?.original()).toBeNull();
    expect(await collect()).toEqual([]);
  });

  it('holds no more than its cap and still gives the text it could not keep', async () => {
    const tiny = new MarkdownMeetingRepository({
      root: fx.root,
      placement: fx.projects,
      foldedTextBytes: 8,
    });
    await tiny.save(meeting({ notes: 'Una nota bastante larga' }));
    const [first] = await collect(tiny);
    expect(first?.folded.notes).toBe('una nota bastante larga');
    const seen = reads(fx.root);
    try {
      await collect(tiny);
      expect(seen.count()).toBe(1);
    } finally {
      seen.restore();
    }
  });
});

describe('batch', () => {
  const outsideFile = () =>
    renderMeetingMarkdown(meeting({ id: ID_B, title: 'Written by another program' }));

  it('scans once: a file that appears during the batch waits for the next scan', async () => {
    await fx.meetings.save(meeting());
    const inbox = path.join(fx.root, 'Inbox');
    await fx.meetings.batch(async () => {
      expect((await fx.meetings.list()).items.map((i) => i.id)).toEqual([ID_A]);
      fs.writeFileSync(path.join(inbox, 'outside.md'), outsideFile());
      expect((await fx.meetings.list()).items.map((i) => i.id)).toEqual([ID_A]);
    });
    expect((await fx.meetings.list()).items.map((i) => i.id).sort()).toEqual([ID_A, ID_B]);
  });

  it('sees its own saves, moves and deletes', async () => {
    fx.projects.add(FOLDER_1, 'Universidad');
    const saved = await fx.meetings.save(meeting());
    await fx.meetings.batch(async () => {
      await fx.meetings.list();
      await fx.meetings.save(meeting({ id: ID_B, title: 'Second' }));
      await fx.meetings.save({ ...saved, projectId: FOLDER_1 });
      expect((await fx.meetings.get(ID_A))?.projectId).toBe(FOLDER_1);
      expect(await fx.meetings.get(ID_B)).toMatchObject({ title: 'Second' });
      expect((await fx.meetings.list()).items).toHaveLength(2);
      await fx.meetings.delete(ID_B);
      expect(await fx.meetings.get(ID_B)).toBeNull();
    });
    expect((await fx.meetings.list()).items.map((i) => i.projectId)).toEqual([FOLDER_1]);
    expect(tree(fx.root)).toContain('Universidad/2026-09-01 Standup.md');
    expect(tree(fx.root)).not.toContain('Inbox/2026-09-01 Standup.md');
  });

  it('goes back to scanning when the batch fails, and nested batches end with the outer one', async () => {
    await fx.meetings.save(meeting());
    const inbox = path.join(fx.root, 'Inbox');
    await expect(
      fx.meetings.batch(async () => {
        await fx.meetings.batch(() => fx.meetings.list());
        fs.writeFileSync(path.join(inbox, 'outside.md'), outsideFile());
        expect((await fx.meetings.list()).items).toHaveLength(1);
        throw new Error('stop');
      }),
    ).rejects.toThrow('stop');
    expect((await fx.meetings.list()).items).toHaveLength(2);
  });
});

describe('list', () => {
  it('walks every depth and returns the light items', async () => {
    fx.projects.add(FOLDER_1, 'Universidad');
    await fx.meetings.save(meeting({ projectId: FOLDER_1, summary: '# T\nBody' }));
    await fx.meetings.save(meeting({ id: ID_B, title: 'Second' }));
    const { items, skipped } = await fx.meetings.list();
    expect(items.map((i) => i.id).sort()).toEqual([ID_A, ID_B]);
    expect(items.find((i) => i.id === ID_A)).toMatchObject({
      projectId: FOLDER_1,
      snippet: 'Body',
    });
    expect(skipped).toEqual([]);
  });

  it('carries the end time and what the meeting holds', async () => {
    await fx.meetings.save(
      meeting({
        endedAt: '2026-09-01T12:30:00.000+00:00',
        summary: 'Body',
        transcript: 'Spoken',
      }),
    );
    await fx.meetings.save(meeting({ id: ID_B, title: 'Second' }));
    const { items } = await fx.meetings.list();
    expect(items.find((i) => i.id === ID_A)).toMatchObject({
      endedAt: '2026-09-01T12:30:00.000+00:00',
      hasSummary: true,
      hasTranscript: true,
      busy: false,
    });
    expect(items.find((i) => i.id === ID_B)).toMatchObject({
      endedAt: null,
      hasSummary: false,
      hasTranscript: false,
      busy: false,
    });
  });

  it('computes the snippet once per file version and reuses it while mtime and size match (item 142)', async () => {
    await fx.meetings.save(meeting({ summary: '# T\nBody' }));
    const first = (await fx.meetings.list()).items[0];
    const second = (await fx.meetings.list()).items[0];
    expect(second).toBe(first);
    expect(first?.snippet).toBe('Body');
  });

  it('an empty or missing root lists nothing', async () => {
    fs.rmSync(fx.root, { recursive: true });
    expect(await fx.meetings.list()).toEqual({ items: [], skipped: [], shadowed: [] });
  });

  it('a corrupt file does not hide the readable meetings, and is reported', async () => {
    await fx.meetings.save(meeting());
    write('Inbox/broken.md', 'not a meeting');
    write(
      'Inbox/bad-jev.md',
      `---\nid: ${ID_B}\nrecordedAt: 2026-09-01T12:00:00Z\n---\n\n## Jev\n\n{oops\n`,
    );
    const { items, skipped } = await fx.meetings.list();
    expect(items.map((i) => i.id)).toEqual([ID_A]);
    expect(skipped.map((s) => path.basename(s.path)).sort()).toEqual(['bad-jev.md', 'broken.md']);
  });

  it('item 47: a file that cannot be read right now is skipped with its code, the rest still list', async () => {
    await fx.meetings.save(meeting());
    write(
      'Inbox/locked.md',
      '---\nid: ' + ID_B + '\ntitle: L\nrecordedAt: 2026-09-01T12:00:00Z\n---\n',
    );
    const real = fsp.readFile.bind(fsp);
    for (const code of ['EBUSY', 'EACCES', 'EPERM', 'ENOENT']) {
      vi.spyOn(fsp, 'readFile').mockImplementation(((file: string, ...rest: unknown[]) =>
        file.endsWith('locked.md')
          ? Promise.reject(Object.assign(new Error(code), { code }))
          : (real as (...a: unknown[]) => Promise<unknown>)(file, ...rest)) as typeof fsp.readFile);
      const { items, skipped } = await fx.meetings.list();
      expect(items.map((i) => i.id)).toEqual([ID_A]);
      expect(skipped.map((s) => path.basename(s.path))).toEqual(['locked.md']);
      expect(skipped[0]?.reason).toBe(code);
      vi.restoreAllMocks();
    }
    // Once readable again, it appears (an unreadable file is never cached).
    expect((await fx.meetings.list()).items.map((i) => i.id).sort()).toEqual([ID_A, ID_B]);
  });

  it('B19 and B28: a second list re-reads no unchanged file and no transcript', async () => {
    await fx.meetings.save(meeting({ transcript: 'T'.repeat(500) }));
    await fx.meetings.save(meeting({ id: ID_B, title: 'Second', summary: 'S' }));
    await fx.meetings.list();
    const target = (await fx.meetings.get(ID_B))?.sourcePath ?? '';
    const spy = vi.spyOn(fsp, 'readFile');
    const second = await fx.meetings.list();
    expect(second.items).toHaveLength(2);
    expect(spy).not.toHaveBeenCalled();
    // A changed file is the only one re-read.
    await new Promise((r) => setTimeout(r, 15));
    fs.writeFileSync(target, fs.readFileSync(target, 'utf8') + '\n');
    await fx.meetings.list();
    expect(spy.mock.calls.map((c) => c[0] as string)).toEqual([target]);
  });

  it('picks up files changed outside the app', async () => {
    const saved = await fx.meetings.save(meeting());
    expect((await fx.meetings.list()).items[0]?.title).toBe('Standup');
    await new Promise((r) => setTimeout(r, 15));
    fs.writeFileSync(
      saved.sourcePath ?? '',
      renderMeetingMarkdown({ ...saved, title: 'Edited outside' }),
    );
    expect((await fx.meetings.list()).items[0]?.title).toBe('Edited outside');
    fs.rmSync(saved.sourcePath ?? '');
    expect((await fx.meetings.list()).items).toEqual([]);
  });

  it('ignores temp files from interrupted writes', async () => {
    await fx.meetings.save(meeting());
    write('Inbox/.x.md.abc123.tmp', '---');
    expect((await fx.meetings.list()).skipped).toEqual([]);
  });
});

describe('duplicate ids (a copied folder)', () => {
  const text = (title: string, extra: Partial<Parameters<typeof meeting>[0]> = {}): string =>
    renderMeetingMarkdown(meeting({ title, ...extra }));
  const stamp = (file: string, iso: string): void => {
    fs.utimesSync(file, new Date(iso), new Date(iso));
  };

  it('the newest file wins and the other is reported as shadowed', async () => {
    const older = write('Trabajo/older.md', text('Older'));
    const newer = write('Trabajo copia/newer.md', text('Newer'));
    stamp(older, '2026-01-01');
    stamp(newer, '2026-06-01');
    const list = await fx.meetings.list();
    expect(list.items.map((i) => i.title)).toEqual(['Newer']);
    expect(list.shadowed).toEqual([{ id: ID_A, keptPath: newer, shadowedPath: older }]);
    expect((await fx.meetings.get(ID_A))?.title).toBe('Newer');
  });

  it('breaks an mtime tie by path, ascending and case-folded, and stays stable', async () => {
    const b = write('B/x.md', text('In B'));
    const a = write('a/x.md', text('In a'));
    stamp(a, '2026-03-03');
    stamp(b, '2026-03-03');
    for (let i = 0; i < 3; i += 1) {
      const list = await fx.meetings.list();
      expect(list.items.map((m) => m.title)).toEqual(['In a']);
      expect(list.shadowed).toEqual([{ id: ID_A, keptPath: a, shadowedPath: b }]);
    }
  });

  it('never rewrites, moves or deletes the shadowed copy: save, move and delete act on the winner', async () => {
    const older = write('Trabajo/older.md', text('Older'));
    const newer = write('Trabajo copia/newer.md', text('Newer'));
    stamp(older, '2026-01-01');
    stamp(newer, '2026-06-01');
    const bytes = fs.readFileSync(older);
    const mtime = fs.statSync(older).mtimeMs;
    fx.projects.add(FOLDER_1, 'Universidad');
    await fx.meetings.save({
      ...(await fx.meetings.get(ID_A))!,
      notes: 'edited',
      projectId: FOLDER_1,
    });
    expect(fs.readFileSync(older)).toEqual(bytes);
    expect(fs.statSync(older).mtimeMs).toBe(mtime);
    expect(fs.existsSync(newer)).toBe(false);
    await fx.meetings.delete(ID_A);
    expect(fs.readFileSync(older)).toEqual(bytes);
    expect(tree(fx.root)).toEqual(['Trabajo/older.md']);
  });

  it('a recording the shadowed copy names is not moved by a move of the winner', async () => {
    const wav = write('Trabajo/clase.wav', 'RIFF');
    const older = write('Trabajo/clase.md', text('Older', { audioFilePath: wav }));
    const newer = write('Copia/clase.md', text('Newer', { audioFilePath: wav }));
    stamp(older, '2026-01-01');
    stamp(newer, '2026-06-01');
    fx.projects.add(FOLDER_1, 'Universidad');
    const moved = await fx.meetings.save({
      ...(await fx.meetings.get(ID_A))!,
      projectId: FOLDER_1,
    });
    expect(fs.readFileSync(wav, 'utf8')).toBe('RIFF');
    expect(moved.audioFilePath).toBe(path.join(fx.root, 'Universidad', '2026-09-01 Newer.wav'));
    expect(fs.readFileSync(moved.audioFilePath, 'utf8')).toBe('RIFF');
    expect(fs.readFileSync(older, 'utf8')).toContain(`audioFilePath: ${wav}`);
  });

  it('a recording the shadowed copy names is not deleted with the winner', async () => {
    const wav = write('Trabajo/clase.wav', 'RIFF');
    const older = write('Trabajo/clase.md', text('Older', { audioFilePath: wav }));
    const newer = write('Copia/clase.md', text('Newer', { audioFilePath: wav }));
    write('Copia/clase.wav', 'RIFF-copy');
    stamp(older, '2026-01-01');
    stamp(newer, '2026-06-01');
    await fx.meetings.delete(ID_A);
    expect(tree(fx.root)).toEqual(['Trabajo/clase.md', 'Trabajo/clase.wav']);
    expect(fs.existsSync(newer)).toBe(false);
  });
});

describe('placement that cannot place now', () => {
  it('keeps an existing meeting exactly where it is, with its project and recording', async () => {
    fx.projects.add(FOLDER_1, 'Universidad');
    const first = await fx.meetings.save(meeting({ projectId: FOLDER_1 }));
    const wav = first.sourcePath?.replace(/\.md$/, '.wav') ?? '';
    fs.writeFileSync(wav, 'RIFF');
    const withAudio = await fx.meetings.save({ ...first, audioFilePath: wav });
    fx.projects.available = false;
    const before = tree(fx.root);
    const saved = await fx.meetings.save({
      ...withAudio,
      notes: 'new notes',
      title: 'Renamed',
      projectId: null,
    });
    expect(tree(fx.root)).toEqual(before);
    expect(saved.sourcePath).toBe(first.sourcePath);
    expect(saved.projectId).toBe(FOLDER_1);
    const back = await fx.meetings.get(ID_A);
    expect(back).toMatchObject({ notes: 'new notes', projectId: FOLDER_1, audioFilePath: wav });
  });

  it('writes a new meeting to the Inbox', async () => {
    fx.projects.available = false;
    const saved = await fx.meetings.save(meeting({ projectId: FOLDER_1 }));
    expect(saved.sourcePath).toBe(path.join(fx.root, 'Inbox', '2026-09-01 Standup.md'));
  });
});

describe('scanning', () => {
  it('ignores dot-directories, so the app storage and its Markdown context files are never meetings', async () => {
    write(
      '.vozella/projects/abc/files/def/original.md',
      renderMeetingMarkdown(meeting({ title: 'Context file that looks like a meeting' })),
    );
    write('.git/notes.md', renderMeetingMarkdown(meeting({ id: ID_B, title: 'Hidden' })));
    write('Inbox/real.md', renderMeetingMarkdown(meeting({ title: 'Real' })));
    const list = await fx.meetings.list();
    expect(list.items.map((i) => i.title)).toEqual(['Real']);
    expect(list.shadowed).toEqual([]);
    expect(list.skipped).toEqual([]);
  });

  it('finds ordinary meetings in directories that used to be special, with no flat-dump rules', async () => {
    write('Meetings/x.md', renderMeetingMarkdown(meeting({ title: 'In Meetings' })));
    write('Recordings/y.md', renderMeetingMarkdown(meeting({ id: ID_B, title: 'In Recordings' })));
    expect((await fx.meetings.list()).items.map((i) => i.title).sort()).toEqual([
      'In Meetings',
      'In Recordings',
    ]);
  });
});

describe('older files round trip through the plain writer', () => {
  it('reads a BOM, CRLF and seven-digit date and rewrites it as plain UTF-8, LF and milliseconds', async () => {
    const old =
      '\uFEFF---\r\nid: ' +
      ID_A +
      '\r\ntitle: Viejo\r\nrecordedAt: 2026-09-01T12:00:00.1234567-05:00\r\naudioFilePath: \r\n---\r\n\r\n## Summary\r\n\r\nhola\r\n';
    const file = write('Inbox/viejo.md', old);
    const loaded = await fx.meetings.get(ID_A);
    expect(loaded).toMatchObject({
      title: 'Viejo',
      recordedAt: '2026-09-01T12:00:00.123-05:00',
      summary: 'hola',
    });
    const saved = await fx.meetings.save({ ...loaded!, notes: 'x' });
    const text = fs.readFileSync(saved.sourcePath ?? file, 'utf8');
    expect(text.startsWith('---\n')).toBe(true);
    expect(text).not.toContain('\r');
    expect(text).toContain('recordedAt: 2026-09-01T12:00:00.123-05:00\n');
  });
});

describe('robustness', () => {
  it('concurrent saves of one meeting end with one file holding the last write', async () => {
    const first = await fx.meetings.save(meeting());
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => fx.meetings.save({ ...first, notes: `note ${i}` })),
    );
    expect(tree(fx.root)).toEqual(['Inbox/2026-09-01 Standup.md']);
    expect((await fx.meetings.get(ID_A))?.notes).toBe('note 7');
  });

  it('concurrent saves of different meetings with one title get distinct stems', async () => {
    const ids = ['3', '4', '5', '6'].map(
      (n) =>
        n.repeat(8) +
        '-' +
        n.repeat(4) +
        '-' +
        n.repeat(4) +
        '-' +
        n.repeat(4) +
        '-' +
        n.repeat(12),
    );
    await Promise.all(ids.map((id) => fx.meetings.save(meeting({ id }))));
    expect(tree(fx.root)).toEqual([
      'Inbox/2026-09-01 Standup 2.md',
      'Inbox/2026-09-01 Standup 3.md',
      'Inbox/2026-09-01 Standup 4.md',
      'Inbox/2026-09-01 Standup.md',
    ]);
  });

  it('a file with a title that sanitizes badly still lands in a legal path', async () => {
    const saved = await fx.meetings.save(meeting({ title: 'Q3: plan/review?' }));
    expect(path.basename(saved.sourcePath ?? '')).toBe('2026-09-01 Q3 plan review.md');
  });

  it('a title holding a newline and --- survives (B3)', async () => {
    await fx.meetings.save(meeting({ title: 'one\n---\ntwo' }));
    expect((await fx.meetings.list()).items[0]?.title).toBe('one --- two');
  });
});

describe('the directory a meeting sits in is a convenience', () => {
  it('the project of a meeting is its frontmatter projectId, not the directory it sits in', async () => {
    fx.projects.add(FOLDER_1, 'Universidad');
    const saved = await fx.meetings.save(meeting({ projectId: FOLDER_1 }));
    // The user drags the file to another directory in the file manager.
    const elsewhere = path.join(fx.root, 'Dragged', 'moved.md');
    fs.mkdirSync(path.dirname(elsewhere), { recursive: true });
    fs.renameSync(saved.sourcePath ?? '', elsewhere);
    const item = (await fx.meetings.list()).items[0];
    expect(item?.projectId).toBe(FOLDER_1);
    expect((await fx.meetings.get(ID_A))?.sourcePath).toBe(elsewhere);
  });
});

describe('the microphone activity sidecar (<name>.mic.json) follows its recording', () => {
  const withRecording = async () => {
    const first = await fx.meetings.save(meeting());
    const wav = first.sourcePath?.replace(/\.md$/, '.wav') ?? '';
    fs.writeFileSync(wav, 'RIFF');
    fs.writeFileSync(wav.replace(/\.wav$/, '.mic.json'), '{"version":1,"ranges":[]}');
    return fx.meetings.save({ ...first, audioFilePath: wav });
  };

  it('moves with the wav when the meeting changes project or title', async () => {
    fx.projects.add(FOLDER_1, 'Universidad');
    const saved = await withRecording();
    await fx.meetings.save({ ...saved, projectId: FOLDER_1, title: 'Retro' });
    expect(tree(fx.root)).toEqual([
      'Universidad/2026-09-01 Retro.md',
      'Universidad/2026-09-01 Retro.mic.json',
      'Universidad/2026-09-01 Retro.wav',
    ]);
  });

  it('is removed with the meeting', async () => {
    await withRecording();
    await fx.meetings.delete(ID_A);
    expect(tree(fx.root)).toEqual([]);
  });

  it('never blocks a delete when it cannot be removed', async () => {
    const f = createLibraryFixture({
      unlink: (p) =>
        p.endsWith('.mic.json')
          ? Promise.reject(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }))
          : fs.promises.unlink(p),
    });
    try {
      const first = await f.meetings.save(meeting());
      const wav = first.sourcePath?.replace(/\.md$/, '.wav') ?? '';
      fs.writeFileSync(wav, 'RIFF');
      fs.writeFileSync(wav.replace(/\.wav$/, '.mic.json'), '{}');
      await f.meetings.save({ ...first, audioFilePath: wav });
      await f.meetings.delete(ID_A);
      expect((await f.meetings.list()).items).toEqual([]);
    } finally {
      f.cleanup();
    }
  });
});
