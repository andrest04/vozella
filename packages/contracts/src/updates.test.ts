import { describe, expect, it } from 'vitest';
import { eventChannels, requestChannels, updateStateSchema, updatesInstall } from './index';

describe('updates contracts', () => {
  it('registers the update requests and event by name', () => {
    expect(Object.keys(requestChannels)).toEqual(
      expect.arrayContaining(['updates.getState', 'updates.install']),
    );
    expect(Object.keys(eventChannels)).toContain('updates.stateChanged');
  });

  it('carries the running version next to the new one', () => {
    expect(
      updateStateSchema.parse({
        currentVersion: '0.9.7',
        update: { status: 'ready', version: '0.10.0' },
      }),
    ).toEqual({ currentVersion: '0.9.7', update: { status: 'ready', version: '0.10.0' } });
  });

  it('rejects a download percent outside 0 to 100', () => {
    expect(
      updateStateSchema.safeParse({
        currentVersion: '1',
        update: { status: 'downloading', version: '2', percent: 120 },
      }).success,
    ).toBe(false);
  });

  it('takes no install input', () => {
    expect(updatesInstall.input.safeParse({ silent: true }).success).toBe(false);
  });
});
