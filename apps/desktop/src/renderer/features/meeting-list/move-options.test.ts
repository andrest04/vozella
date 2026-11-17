import { describe, expect, it } from 'vitest';
import { moveOptions } from './move-options';
import { orderProjectChoices } from './project-order';

const projects = [
  { id: 'p1', name: 'Zeta', pinned: false },
  { id: 'p2', name: 'álgebra', pinned: false },
  { id: 'p3', name: 'Mercadeo', pinned: true },
];
const base = { projects, locale: 'es', noProjectLabel: 'Sin proyecto', query: '' };
const labels = (list: readonly { label: string }[]) => list.map((o) => o.label);

describe('orderProjectChoices', () => {
  it('puts pinned projects first, then the rest by folded name', () => {
    expect(orderProjectChoices(projects, 'es').map((p) => p.name)).toEqual([
      'Mercadeo',
      'álgebra',
      'Zeta',
    ]);
  });
});

describe('moveOptions', () => {
  it('offers every project for meetings with no project, and no No project entry', () => {
    expect(labels(moveOptions({ ...base, from: [null] }))).toEqual(['Mercadeo', 'álgebra', 'Zeta']);
  });

  it('offers No project first for a meeting that is in a project, and leaves that project out', () => {
    expect(labels(moveOptions({ ...base, from: ['p2'] }))).toEqual([
      'Sin proyecto',
      'Mercadeo',
      'Zeta',
    ]);
  });

  it('keeps every project when the meetings are in different places', () => {
    expect(labels(moveOptions({ ...base, from: ['p2', null] }))).toEqual([
      'Sin proyecto',
      'Mercadeo',
      'álgebra',
      'Zeta',
    ]);
  });

  it('reads an id that is not a project as no project', () => {
    expect(labels(moveOptions({ ...base, from: ['gone'] }))).toEqual([
      'Mercadeo',
      'álgebra',
      'Zeta',
    ]);
  });

  it('filters by folded words, accents and case aside', () => {
    expect(labels(moveOptions({ ...base, from: ['p3'], query: 'ALGEBRA' }))).toEqual(['álgebra']);
    expect(labels(moveOptions({ ...base, from: ['p3'], query: 'sin' }))).toEqual(['Sin proyecto']);
    expect(moveOptions({ ...base, from: ['p3'], query: 'zzz' })).toEqual([]);
  });
});
