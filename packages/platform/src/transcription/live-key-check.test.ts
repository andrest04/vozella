import { ApiProviderError, CancelSource, type CancelSignal } from '@vozella/core';
import { describe, expect, it, vi } from 'vitest';
import { LiveKeyCheck } from './live-key-check';

const KEY = 'live-key-check-secret-0123';

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

/** A check whose provider answers with `answer`, and the failures it gave. */
function check(answer: () => Promise<void> = () => Promise.resolve()) {
  const asked = vi.fn((_key: string, _cancel: CancelSignal) => answer());
  const keys = new LiveKeyCheck('Provider', asked);
  const ended: ApiProviderError[] = [];
  const explain = (key: string, cancel: CancelSignal = new CancelSource().signal): void => {
    keys.explain(key, cancel, (failure) => ended.push(failure));
  };
  return { keys, asked, ended, explain };
}

describe('LiveKeyCheck: why a live session never opened', () => {
  it('asks the provider about a key it has not seen, with the cancel of the pass', async () => {
    const { asked, explain } = check();
    const cancel = new CancelSource().signal;
    explain(KEY, cancel);
    await settle();
    expect(asked).toHaveBeenCalledTimes(1);
    expect(asked).toHaveBeenCalledWith(KEY, cancel);
  });

  it('an accepted key leaves a connection failure', async () => {
    const { ended, explain } = check();
    explain(KEY);
    await settle();
    expect(ended).toHaveLength(1);
    expect(ended[0]).toBeInstanceOf(ApiProviderError);
    expect(ended[0]).toMatchObject({ kind: 'Network', displayName: 'Provider' });
  });

  it('a refused key is the failure the provider answered', async () => {
    const refused = new ApiProviderError('Provider', 'KeyInvalid');
    const { ended, explain } = check(() => Promise.reject(refused));
    explain(KEY);
    await settle();
    expect(ended).toEqual([refused]);
  });

  it('anything else the check throws is a connection failure, never its text', async () => {
    const { ended, explain } = check(() => Promise.reject(new Error(`boom ${KEY}`)));
    explain(KEY);
    await settle();
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ kind: 'Network', displayName: 'Provider' });
    expect(ended[0]?.message).not.toContain(KEY);
  });

  it('a key an earlier session opened with is the network at once, without asking again', () => {
    const { keys, asked, ended, explain } = check();
    keys.accept(KEY);
    explain(KEY);
    // Told before any await: the provider already took this key.
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ kind: 'Network', displayName: 'Provider' });
    expect(asked).not.toHaveBeenCalled();
  });

  it('asks again about a key other than the one accepted, and about an empty key', async () => {
    const { keys, asked, explain } = check();
    keys.accept(KEY);
    explain('another-key');
    keys.accept('');
    explain('');
    await settle();
    expect(asked.mock.calls.map(([key]) => key)).toEqual(['another-key', '']);
  });
});
