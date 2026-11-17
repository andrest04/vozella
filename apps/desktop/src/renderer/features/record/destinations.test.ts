import { describe, expect, it } from 'vitest';
import {
  buildDestinations,
  fromOptionValue,
  retainDestination,
  toOptionValue,
} from './destinations';

const project = (id: string, name: string, pinned = false) => ({ id, name, pinned });

describe('buildDestinations', () => {
  const projects = [
    project('b', 'beta'),
    project('a', 'Alpha'),
    project('z', 'Zeta', true),
    project('c', 'álgebra', true),
  ];

  it('lists No project first, then the pinned projects, then the rest by name, flat', () => {
    const list = buildDestinations(projects, 'No project', 'en');
    expect(list.map((d) => d.label)).toEqual(['No project', 'álgebra', 'Zeta', 'Alpha', 'beta']);
    expect(list[0]?.projectId).toBeNull();
  });

  it('uses the label it is given for No project, so it follows the language', () => {
    expect(buildDestinations([], 'Sin proyecto', 'es')).toEqual([
      { projectId: null, label: 'Sin proyecto' },
    ]);
  });

  it('keeps the selection while the project exists and falls back to No project', () => {
    const list = buildDestinations(projects, 'No project', 'en');
    expect(retainDestination('a', list)).toBe('a');
    expect(retainDestination('gone', list)).toBeNull();
    expect(retainDestination(null, list)).toBeNull();
  });

  it('maps No project to a select value and back', () => {
    expect(fromOptionValue(toOptionValue(null))).toBeNull();
    expect(fromOptionValue(toOptionValue('x'))).toBe('x');
  });
});
