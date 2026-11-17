import { describe, expect, it } from 'vitest';
import {
  foldProjectName,
  planProjects,
  resolveMigratedNames,
  validateProjectName,
  type LegacyFolderEntry,
} from './project-names';

const NOW = '2026-11-17T00:00:00.000Z';
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function entry(
  n: number,
  name: string | null,
  parent: number | string | null = null,
  extra: Partial<LegacyFolderEntry> = {},
): LegacyFolderEntry {
  return {
    id: id(n),
    name,
    parentId: parent === null ? null : typeof parent === 'number' ? id(parent) : parent,
    note: null,
    createdAt: `2025-03-0${String(Math.min(n, 9))}T10:00:00-05:00`,
    ...extra,
  };
}

const names = (plan: ReturnType<typeof planProjects>): string[] => plan.projects.map((p) => p.name);

describe('validateProjectName', () => {
  it('trims and accepts', () => {
    expect(validateProjectName('  Cálculo  ')).toEqual({ ok: true, name: 'Cálculo' });
  });
  it('refuses empty and whitespace-only', () => {
    expect(validateProjectName('   ')).toEqual({ ok: false, reason: 'empty-name' });
    expect(validateProjectName('')).toEqual({ ok: false, reason: 'empty-name' });
  });
  it('refuses more than 120 characters but accepts exactly 120', () => {
    expect(validateProjectName('a'.repeat(120)).ok).toBe(true);
    expect(validateProjectName('a'.repeat(121))).toEqual({ ok: false, reason: 'too-long' });
  });
});

describe('foldProjectName', () => {
  it('ignores case, accents and surrounding space', () => {
    expect(foldProjectName(' CÁLCULO ')).toBe(foldProjectName('calculo'));
  });
});

describe('planProjects', () => {
  it('keeps ids, notes as instructions and converts createdAt to UTC', () => {
    const plan = planProjects([entry(1, 'Universidad', null, { note: 'Resumir en español' })], {
      now: NOW,
    });
    expect(plan.projects).toHaveLength(1);
    const [p] = plan.projects;
    expect(p?.id).toBe(id(1));
    expect(p?.instructions).toBe('Resumir en español');
    expect(p?.createdAt).toBe('2025-03-01T15:00:00.000Z');
    expect(p?.parentId).toBeNull();
  });

  it('lowercases ids and accepts braces', () => {
    const plan = planProjects([{ ...entry(1, 'A'), id: `{${id(1).toUpperCase()}}` }], { now: NOW });
    expect(plan.projects[0]?.id).toBe(id(1));
  });

  it('skips invalid ids and reports them by index', () => {
    const plan = planProjects(
      [
        entry(1, 'A'),
        { ...entry(2, 'B'), id: '../evil' },
        { ...entry(3, 'C'), id: null },
        { ...entry(4, 'D'), id: 'CON' },
      ],
      { now: NOW },
    );
    expect(names(plan)).toEqual(['A']);
    expect(plan.skipped).toEqual([
      { index: 1, reason: 'invalid-id' },
      { index: 2, reason: 'invalid-id' },
      { index: 3, reason: 'invalid-id' },
    ]);
  });

  it('keeps the first of duplicate ids and reports the rest, including case-only duplicates', () => {
    const plan = planProjects(
      [entry(1, 'First'), { ...entry(1, 'Second'), id: id(1).toUpperCase() }, entry(1, 'Third')],
      { now: NOW },
    );
    expect(names(plan)).toEqual(['First']);
    expect(plan.skipped).toEqual([
      { index: 1, reason: 'duplicate-id' },
      { index: 2, reason: 'duplicate-id' },
    ]);
  });

  it('turns a missing parent into a root', () => {
    const plan = planProjects([entry(1, 'Child', 99)], { now: NOW });
    expect(plan.projects[0]?.parentId).toBeNull();
    expect(plan.projects[0]?.cycleBroken).toBe(false);
  });

  it('turns a self parent into a root', () => {
    const plan = planProjects([entry(1, 'Loop', 1)], { now: NOW });
    expect(plan.projects[0]?.parentId).toBeNull();
    expect(plan.projects[0]?.cycleBroken).toBe(true);
  });

  it('makes both nodes of A -> B -> A roots, and a child of the cycle too', () => {
    const plan = planProjects([entry(1, 'A', 2), entry(2, 'B', 1), entry(3, 'C', 1)], { now: NOW });
    expect(plan.projects.map((p) => p.parentId)).toEqual([null, null, null]);
    expect(plan.projects.every((p) => p.cycleBroken)).toBe(true);
  });

  it('keeps a chain of exactly 32 ancestors and breaks deeper ones', () => {
    const chain: LegacyFolderEntry[] = [entry(1, 'n1')];
    for (let n = 2; n <= 40; n += 1) chain.push(entry(n, `n${String(n)}`, n - 1));
    const plan = planProjects(chain, { now: NOW });
    const byName = new Map(plan.projects.map((p) => [p.name, p]));
    expect(byName.get('n33')?.parentId).toBe(id(32)); // 32 ancestors
    expect(byName.get('n34')?.parentId).toBeNull(); // 33 ancestors
    expect(byName.get('n34')?.cycleBroken).toBe(true);
    expect(byName.get('n40')?.parentId).toBeNull();
  });

  it('cleans names: trim, empty becomes Project, long names are cut at 120', () => {
    const plan = planProjects(
      [entry(1, '  Hola  '), entry(2, '   '), entry(3, null), entry(4, 'x'.repeat(300))],
      { now: NOW },
    );
    expect(plan.projects[0]?.name).toBe('Hola');
    expect(plan.projects[1]?.name).toBe('Project');
    expect(plan.projects[2]?.name).toBe('Project 2');
    expect(plan.projects[3]?.name).toHaveLength(120);
  });

  it('falls back to now when createdAt is unreadable', () => {
    const plan = planProjects(
      [entry(1, 'A', null, { createdAt: 'not a date' }), entry(2, 'B', null, { createdAt: null })],
      { now: NOW },
    );
    expect(plan.projects.map((p) => p.createdAt)).toEqual([NOW, NOW]);
  });

  it('is deterministic: the same input gives the same plan', () => {
    const input = [
      entry(2, 'Cálculo', 1),
      entry(1, 'Universidad'),
      entry(3, 'Cálculo', 4),
      entry(4, 'Trabajo'),
    ];
    expect(planProjects(input, { now: NOW })).toEqual(planProjects([...input], { now: NOW }));
  });

  it('reports renamed projects', () => {
    const plan = planProjects(
      [
        entry(1, 'Universidad'),
        entry(2, 'Cálculo', 1),
        entry(3, 'Trabajo'),
        entry(4, 'Cálculo', 3),
      ],
      { now: NOW },
    );
    expect(plan.renamed).toEqual([
      { id: id(2), from: 'Cálculo', to: 'Universidad – Cálculo' },
      { id: id(4), from: 'Cálculo', to: 'Trabajo – Cálculo' },
    ]);
  });

  it('keeps the original parent id of a folder as origin data', () => {
    const plan = planProjects([entry(1, 'A', 2), entry(2, 'B', 1)], { now: NOW });
    expect(plan.projects[0]?.originalParentId).toBe(id(2));
  });
});

describe('resolveMigratedNames', () => {
  const f = (
    n: number,
    name: string,
    parentId: number | null,
    createdAt = '2025-01-01T00:00:00.000Z',
  ) => ({
    id: id(n),
    name,
    parentId: parentId === null ? null : id(parentId),
    createdAt,
  });
  const resolve = (list: ReturnType<typeof f>[]): string[] => {
    const out = resolveMigratedNames(list);
    return list.map((x) => out.get(x.id) ?? '?');
  };

  it('keeps unique names', () => {
    expect(resolve([f(1, 'A', null), f(2, 'B', 1)])).toEqual(['A', 'B']);
  });

  it('prefixes the parent name for colliding names, ignoring case and accents', () => {
    expect(
      resolve([
        f(1, 'Universidad', null),
        f(2, 'Cálculo', 1),
        f(3, 'Trabajo', null),
        f(4, 'CALCULO', 3),
      ]),
    ).toEqual(['Universidad', 'Universidad – Cálculo', 'Trabajo', 'Trabajo – CALCULO']);
  });

  it('lets roots keep their name when they collide with a child', () => {
    expect(resolve([f(1, 'Notas', null), f(2, 'Padre', null), f(3, 'notas', 2)])).toEqual([
      'Notas',
      'Padre',
      'Padre – notas',
    ]);
  });

  it('uses the whole ancestor chain when the parent prefix still collides', () => {
    const list = [
      f(1, 'U', null),
      f(2, 'Cursos', 1),
      f(3, 'Cálculo', 2),
      f(4, 'V', null),
      f(5, 'Cursos', 4),
      f(6, 'Cálculo', 5),
    ];
    const out = resolve(list);
    expect(out[2]).toBe('U – Cursos – Cálculo');
    expect(out[5]).toBe('V – Cursos – Cálculo');
    expect(new Set(out.map((n) => n.toLowerCase())).size).toBe(out.length);
  });

  it('numbers roots that collide among themselves, oldest first then id', () => {
    const out = resolve([
      f(2, 'Notas', null, '2025-02-01T00:00:00.000Z'),
      f(1, 'notas', null, '2025-01-01T00:00:00.000Z'),
    ]);
    expect(out).toEqual(['Notas 2', 'notas']);
  });

  it('numbers a renamed folder whose new name still collides with a root', () => {
    const out = resolve([
      f(1, 'P', null),
      f(2, 'P – Q', null),
      f(3, 'Q', 1),
      f(4, 'Q', 5),
      f(5, 'R', null),
    ]);
    expect(out[1]).toBe('P – Q');
    expect(out[2]).toBe('P – Q 2');
    expect(out[3]).toBe('R – Q');
  });

  it('never exceeds 120 characters and stays unique', () => {
    const long = 'x'.repeat(120);
    const out = resolve([f(1, long, null), f(2, long, null), f(3, long, null)]);
    expect(out.every((n) => n.length <= 120)).toBe(true);
    expect(new Set(out).size).toBe(3);
  });
});
