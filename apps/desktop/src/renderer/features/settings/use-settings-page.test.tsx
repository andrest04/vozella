// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Providers } from '../../app/test-providers';
import { resetSettingsPageCache, useSettingsPage } from './use-settings-page';

type Handler = (input: unknown) => unknown;

function install(handlers: Record<string, Handler>) {
  const calls: { name: string; input: unknown }[] = [];
  const invoke = (name: string, input: unknown): Promise<unknown> => {
    calls.push({ name, input });
    const handler = handlers[name];
    if (!handler) return Promise.reject(new Error(`unhandled ${name}`));
    return Promise.resolve(handler(input));
  };
  Object.defineProperty(window, 'vozella', {
    value: { invoke, on: () => () => undefined },
    configurable: true,
    writable: true,
  });
  return calls;
}

const wrapper = ({ children }: { children: ReactNode }) => (
  <Providers locale="en">{children}</Providers>
);

async function mount(handlers: Record<string, Handler>) {
  const calls = install({ 'settings.getPage': () => ({}), ...handlers });
  const hook = renderHook(() => useSettingsPage(), { wrapper });
  await waitFor(() => {
    expect(hook.result.current.loading).toBe(false);
  });
  const sent = (prefix: string) => calls.filter((call) => call.name.startsWith(prefix));
  return { model: () => hook.result.current, calls, sent };
}

beforeEach(resetSettingsPageCache);
afterEach(() => {
  Reflect.deleteProperty(window, 'vozella');
});

describe('useSettingsPage: the key commands by kind of provider', () => {
  it('saves and removes the key of an API engine on the settings channels', async () => {
    const { model, calls } = await mount({
      'settings.setApiKey': () => ({ status: 'saved', keySet: true }),
      'settings.clearApiKey': () => ({ status: 'saved', keySet: false }),
    });
    await act(async () => {
      expect(await model().setApiKey('Groq', 'gsk-test')).toEqual({
        status: 'saved',
        keySet: true,
      });
      expect(await model().clearApiKey('Groq')).toEqual({ status: 'saved', keySet: false });
    });
    expect(calls.filter((call) => call.name !== 'settings.getPage')).toEqual([
      { name: 'settings.setApiKey', input: { kind: 'Groq', key: 'gsk-test' } },
      { name: 'settings.clearApiKey', input: { kind: 'Groq' } },
    ]);
  });

  it('saves and removes the key of a transcription-only provider on its own channels, then reads the page again', async () => {
    const { model, calls, sent } = await mount({
      'transcription.setProviderKey': () => ({ status: 'saved', keySet: true }),
      'transcription.clearProviderKey': () => ({ status: 'saved', keySet: false }),
    });
    await act(async () => {
      expect(await model().setApiKey('Deepgram', 'dg-test')).toEqual({
        status: 'saved',
        keySet: true,
      });
      expect(await model().clearApiKey('Deepgram')).toEqual({ status: 'saved', keySet: false });
    });
    expect(sent('transcription.')).toEqual([
      { name: 'transcription.setProviderKey', input: { kind: 'Deepgram', key: 'dg-test' } },
      { name: 'transcription.clearProviderKey', input: { kind: 'Deepgram' } },
    ]);
    // Never on the API engine channels, which refuse the kind.
    expect(calls.some((call) => /^settings\.(set|clear|verify)ApiKey$/.test(call.name))).toBe(
      false,
    );
    // The first load, then one after each change: the page shows the new key flag.
    expect(sent('settings.getPage')).toHaveLength(3);
  });

  it('verifies a transcription-only provider without a model list, and changes nothing', async () => {
    const { model, sent } = await mount({
      'transcription.verifyProviderKey': () => ({ status: 'verified' }),
    });
    await act(async () => {
      expect(await model().verifyApiKey('Deepgram')).toEqual({ status: 'verified', models: [] });
    });
    expect(sent('transcription.')).toEqual([
      { name: 'transcription.verifyProviderKey', input: { kind: 'Deepgram' } },
    ]);
    expect(sent('settings.getPage')).toHaveLength(1);
  });

  it('passes on the reason of a failed Verify, and words a broken call as unknown', async () => {
    const refused = await mount({
      'transcription.verifyProviderKey': () => ({ status: 'failed', errorKey: 'Ui_ApiKeyInvalid' }),
    });
    await act(async () => {
      expect(await refused.model().verifyApiKey('Deepgram')).toEqual({
        status: 'failed',
        errorKey: 'Ui_ApiKeyInvalid',
      });
    });
    const broken = await mount({});
    await act(async () => {
      expect(await broken.model().verifyApiKey('Deepgram')).toEqual({
        status: 'failed',
        errorKey: 'Ui_ApiUnknown',
      });
    });
  });
});
