import { describe, expect, it } from 'vitest';
import { liveRepository } from './live-repository';

class Repo {
  constructor(private readonly root: string) {}
  get(id: string): string {
    return `${this.root}/${id}`;
  }
}

describe('liveRepository', () => {
  it('forwards each call to the repository current at call time, keeping `this`', () => {
    let current = new Repo('old');
    const live = liveRepository(() => current);
    expect(live.get('a')).toBe('old/a');
    current = new Repo('new');
    expect(live.get('a')).toBe('new/a');
  });

  it('reads a detached method from the current repository', () => {
    let current = new Repo('old');
    const live = liveRepository(() => current);
    current = new Repo('new');
    const { get } = live;
    expect(get('b')).toBe('new/b');
  });
});
