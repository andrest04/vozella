import { describe, expect, it, vi } from 'vitest';
import { WindowScanner } from '../native/window-scanner';
import { FakeWindowLister } from './fake-window-scanner';

describe('WindowScanner over a fake lister', () => {
  it('names the app of the meeting call window', async () => {
    const lister = new FakeWindowLister([
      { processName: 'notepad', title: 'notes' },
      { processName: 'Zoom', title: 'Zoom Meeting' },
    ]);
    await expect(new WindowScanner(lister).findMeetingWindow()).resolves.toEqual({ app: 'zoom' });
  });

  it('finds nothing when no window is a call', async () => {
    const lister = new FakeWindowLister([
      { processName: 'chrome', title: 'Inbox' },
      { processName: 'teams', title: 'Calls | Microsoft Teams' },
    ]);
    await expect(new WindowScanner(lister).findMeetingWindow()).resolves.toBeNull();
  });

  it('finds nothing in an empty window list', async () => {
    await expect(new WindowScanner(new FakeWindowLister()).findMeetingWindow()).resolves.toBeNull();
  });

  it('skips windows with an empty title or process name', async () => {
    const lister = new FakeWindowLister([
      { processName: 'cpthost', title: '' },
      { processName: '', title: 'Zoom Meeting' },
    ]);
    await expect(new WindowScanner(lister).findMeetingWindow()).resolves.toBeNull();
  });

  it('stops at the first match, whatever follows it', async () => {
    const trap = {
      get processName(): string {
        throw new Error('read past the first match');
      },
      title: 'x',
    };
    const lister = new FakeWindowLister([
      { processName: 'ms-teams', title: 'Standup | Meeting' },
      { processName: 'cpthost', title: 'a' },
      trap,
    ]);
    await expect(new WindowScanner(lister).findMeetingWindow()).resolves.toEqual({ app: 'teams' });
  });

  it('swallows a listing failure as no call and reports it once', async () => {
    const lister = new FakeWindowLister([{ processName: 'cpthost', title: 'a' }]);
    lister.failWith = new Error('EnumWindows failed');
    const onError = vi.fn();
    await expect(new WindowScanner(lister, onError).findMeetingWindow()).resolves.toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('names Google Meet in a browser tab', async () => {
    const lister = new FakeWindowLister([
      { processName: 'chrome', title: 'Meet - abc-defg-hij - Google Chrome' },
    ]);
    await expect(new WindowScanner(lister).findMeetingWindow()).resolves.toEqual({ app: 'meet' });
  });

  it('swallows a non-Error rejection', async () => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    const scanner = new WindowScanner({ listWindows: () => Promise.reject('boom') });
    await expect(scanner.findMeetingWindow()).resolves.toBeNull();
  });
});
