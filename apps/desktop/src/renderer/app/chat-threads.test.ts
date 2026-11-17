import { describe, expect, it } from 'vitest';
import { sortThreads, threadBadge } from './chat-threads';

const thread = (
  kind: 'Project' | 'AllMeetings' | 'Live' | 'Meeting',
  meetingId: string | null = null,
) => ({
  scope: { kind, meetingId },
});

describe('threadBadge', () => {
  const titles = new Map([['m1', 'Weekly sync']]);
  it('names the scope of each kind', () => {
    expect(threadBadge(thread('Project'), titles)).toEqual({ kind: 'project' });
    expect(threadBadge(thread('AllMeetings'), titles)).toEqual({ kind: 'all' });
    expect(threadBadge(thread('Live'), titles)).toEqual({ kind: 'live' });
    expect(threadBadge(thread('Meeting', 'm1'), titles)).toEqual({
      kind: 'meeting',
      title: 'Weekly sync',
    });
  });
  it('says Meeting deleted only when the meetings are loaded and this one is not there', () => {
    expect(threadBadge(thread('Meeting', 'gone'), titles)).toEqual({ kind: 'meeting-deleted' });
    expect(threadBadge(thread('Meeting', 'gone'), null)).toEqual({ kind: 'meeting', title: null });
  });
});

describe('sortThreads', () => {
  it('puts the newest activity first', () => {
    const a = { id: 'a', updatedAt: '2026-01-01T00:00:00.000Z' };
    const b = { id: 'b', updatedAt: '2026-03-01T00:00:00.000Z' };
    const c = { id: 'c', updatedAt: '2026-02-01T00:00:00.000Z' };
    expect(sortThreads([a, b, c] as never).map((x) => x.id)).toEqual(['b', 'c', 'a']);
  });
});
