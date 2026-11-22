import { describe, expect, it } from 'vitest';
import { projectItem } from '../../test-support/project-fixtures';
import { arrangeProjects, formatActivity } from './project-list-model';

const items = [
  projectItem(1, 'Cálculo', {
    description: 'Clases de la universidad',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastActivityAt: '2026-03-01T00:00:00.000Z',
  }),
  projectItem(2, 'Álgebra', {
    createdAt: '2026-02-01T00:00:00.000Z',
    lastActivityAt: '2026-05-01T00:00:00.000Z',
    pinned: true,
  }),
  projectItem(3, 'Producto Q4', {
    createdAt: '2026-03-01T00:00:00.000Z',
    lastActivityAt: '2026-04-01T00:00:00.000Z',
  }),
  projectItem(4, 'Biología', {
    createdAt: '2026-04-01T00:00:00.000Z',
    lastActivityAt: '2026-01-15T00:00:00.000Z',
    pinned: true,
  }),
];

const names = (list: readonly { name: string }[]) => list.map((p) => p.name);

describe('arrangeProjects', () => {
  it('orders by recent activity, newest first, with pinned projects in their own group', () => {
    const { pinned, others } = arrangeProjects(items, { query: '', sort: 'recent', locale: 'en' });
    expect(names(pinned)).toEqual(['Álgebra', 'Biología']);
    expect(names(others)).toEqual(['Producto Q4', 'Cálculo']);
  });

  it('orders by name on folded text, so accents and case do not decide', () => {
    const { pinned, others } = arrangeProjects(items, { query: '', sort: 'name', locale: 'es' });
    expect(names(pinned)).toEqual(['Álgebra', 'Biología']);
    expect(names(others)).toEqual(['Cálculo', 'Producto Q4']);
  });

  it('orders Newest by creation date, descending, not by activity', () => {
    const { pinned, others } = arrangeProjects(items, { query: '', sort: 'newest', locale: 'en' });
    expect(names(pinned)).toEqual(['Biología', 'Álgebra']);
    expect(names(others)).toEqual(['Producto Q4', 'Cálculo']);
  });

  it('searches name and description by folded words, in any order', () => {
    expect(
      names(arrangeProjects(items, { query: 'ALGEBRA', sort: 'recent', locale: 'en' }).pinned),
    ).toEqual(['Álgebra']);
    const byDescription = arrangeProjects(items, {
      query: 'universidad clases',
      sort: 'recent',
      locale: 'en',
    });
    expect(names(byDescription.others)).toEqual(['Cálculo']);
    expect(byDescription.pinned).toEqual([]);
  });

  it('keeps ties stable by name', () => {
    const same = [projectItem(5, 'Zeta'), projectItem(6, 'Alfa')];
    expect(
      names(arrangeProjects(same, { query: '', sort: 'recent', locale: 'en' }).others),
    ).toEqual(['Alfa', 'Zeta']);
  });

  it('has no groups when nothing matches', () => {
    const none = arrangeProjects(items, { query: 'zzz', sort: 'recent', locale: 'en' });
    expect(none.pinned).toEqual([]);
    expect(none.others).toEqual([]);
  });
});

describe('formatActivity', () => {
  const now = new Date('2026-11-17T12:00:00.000Z').getTime();
  it('shows day and month in the same year', () => {
    expect(formatActivity('2026-11-14T12:00:00.000Z', 'en', now)).toBe('14 Nov');
  });
  it('adds the year when it differs', () => {
    expect(formatActivity('2025-03-02T12:00:00.000Z', 'en', now)).toBe('2 Mar 2025');
  });
  it('follows the language', () => {
    expect(formatActivity('2026-11-14T12:00:00.000Z', 'es', now)).toMatch(/^14 nov/);
  });
  it('is empty for text that is not a date', () => {
    expect(formatActivity('nonsense', 'en', now)).toBe('');
  });
});
