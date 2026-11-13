import { describe, expect, it } from 'vitest';
import {
  appRestart,
  commitOutcomeSchema,
  eventChannels,
  i18nGetLocale,
  requestChannels,
  settingsModelsDelete,
  settingsModelsDownload,
  settingsPageSchema,
  settingsClearApiKey,
  settingsSetApiKey,
  settingsSetApiOption,
  settingsSetCliOption,
  settingsVerifyApiKey,
  settingsSetMeetingLanguage,
  summariesProviderStatus,
} from './index';

describe('settings contracts', () => {
  it('registers every settings request and event by name', () => {
    for (const name of [
      'settings.getPage',
      'settings.setUiLanguage',
      'settings.setSummaryProvider',
      'settings.setCliOption',
      'settings.setApiOption',
      'settings.setApiKey',
      'settings.clearApiKey',
      'settings.verifyApiKey',
      'settings.setMeetingLanguage',
      'settings.detectCli',
      'settings.dismissNotice',
      'settings.models.download',
      'settings.models.cancel',
      'settings.models.select',
      'settings.models.delete',
      'i18n.getLocale',
      'app.restart',
    ]) {
      expect(Object.keys(requestChannels)).toContain(name);
    }
    expect(Object.keys(eventChannels)).toEqual(
      expect.arrayContaining(['settings.modelEvent', 'i18n.localeChanged']),
    );
  });

  it('BYOK: the API option input names an API kind and a bounded value, never a key', () => {
    const ok = { kind: 'OpenAiCompatible', field: 'baseUrl', value: 'http://localhost:11434/v1' };
    expect(settingsSetApiOption.input.safeParse(ok).success).toBe(true);
    expect(
      settingsSetApiOption.input.safeParse({ kind: 'Gemini', field: 'model', value: 'g' }).success,
    ).toBe(true);
    expect(
      settingsSetApiOption.input.safeParse({ kind: 'Codex', field: 'model', value: 'g' }).success,
    ).toBe(false);
    expect(
      settingsSetApiOption.input.safeParse({ kind: 'OpenAi', field: 'key', value: 'sk-x' }).success,
    ).toBe(false);
    expect(settingsSetApiOption.input.safeParse({ ...ok, value: 'x'.repeat(301) }).success).toBe(
      false,
    );
  });

  it('BYOK: the key travels only toward main; every answer is a flag, a model list or a key name', () => {
    expect(settingsSetApiKey.input.safeParse({ kind: 'OpenAi', key: 'sk-test' }).success).toBe(
      true,
    );
    expect(settingsSetApiKey.input.safeParse({ kind: 'Local', key: 'sk-test' }).success).toBe(
      false,
    );
    expect(
      settingsSetApiKey.input.safeParse({ kind: 'OpenAi', key: 'x'.repeat(2001) }).success,
    ).toBe(false);
    expect(settingsSetApiKey.output.safeParse({ status: 'saved', keySet: true }).success).toBe(
      true,
    );
    expect(
      settingsSetApiKey.output.safeParse({ status: 'saved', keySet: true, key: 'sk-test' }).success,
    ).toBe(false);
    expect(
      settingsSetApiKey.output.safeParse({
        status: 'failed',
        errorKey: 'Ui_ApiKeyStoreUnavailable',
      }).success,
    ).toBe(true);
    expect(settingsClearApiKey.input.safeParse({ kind: 'Anthropic' }).success).toBe(true);
    expect(settingsVerifyApiKey.input.safeParse({ kind: 'Gemini' }).success).toBe(true);
    expect(settingsVerifyApiKey.input.safeParse({ kind: 'Gemini', key: 'k' }).success).toBe(false);
    expect(
      settingsVerifyApiKey.output.safeParse({ status: 'verified', models: ['gpt-5'] }).success,
    ).toBe(true);
    expect(
      settingsVerifyApiKey.output.safeParse({ status: 'failed', errorKey: 'Ui_ApiKeyInvalid' })
        .success,
    ).toBe(true);
  });

  it('BYOK: the page carries key-set flags per API engine and refuses a key field', () => {
    const engine = {
      keySet: true,
      model: 'gpt-5-mini',
      modelOptions: ['gpt-5-mini'],
      baseUrl: null,
    };
    const api = settingsPageSchema.shape.api;
    const all = { OpenAi: engine, Anthropic: engine, Gemini: engine, OpenAiCompatible: engine };
    expect(api.safeParse(all).success).toBe(true);
    expect(api.safeParse({ ...all, OpenAi: { ...engine, key: 'sk-secret' } }).success).toBe(false);
  });

  it('the page lists every selectable engine with its readiness, and refuses Xai', () => {
    const engines = settingsPageSchema.shape.engines;
    expect(
      engines.safeParse([
        { kind: 'Local', readiness: 'needs-model', model: null },
        { kind: 'ClaudeCode', readiness: 'ready', model: 'sonnet' },
        { kind: 'Codex', readiness: 'cli-missing', model: 'gpt-5.6' },
        { kind: 'OpenAi', readiness: 'needs-key', model: 'gpt-6-astra' },
        { kind: 'OpenAiCompatible', readiness: 'needs-server', model: null },
      ]).success,
    ).toBe(true);
    expect(engines.safeParse([{ kind: 'Xai', readiness: 'ready', model: null }]).success).toBe(
      false,
    );
    expect(engines.safeParse([{ kind: 'Local', readiness: 'whatever', model: null }]).success).toBe(
      false,
    );
  });

  it('BYOK: the provider gate can say a key or an endpoint is missing', () => {
    for (const reason of ['key-missing', 'base-url-missing']) {
      expect(
        summariesProviderStatus.output.safeParse({ status: 'needs-setup', kind: 'Gemini', reason })
          .success,
      ).toBe(true);
    }
  });

  it('a change answers with a value for saved, ignored and failed', () => {
    expect(commitOutcomeSchema.safeParse({ status: 'ignored', reason: 'unchanged' }).success).toBe(
      true,
    );
    expect(commitOutcomeSchema.safeParse({ status: 'failed', message: 'disk full' }).success).toBe(
      true,
    );
    expect(commitOutcomeSchema.safeParse({ status: 'ignored', reason: 'whatever' }).success).toBe(
      false,
    );
  });

  it('command inputs are bounded and typed', () => {
    expect(
      settingsSetCliOption.input.safeParse({ provider: 'claude', field: 'model', value: 'opus' })
        .success,
    ).toBe(true);
    expect(
      settingsSetCliOption.input.safeParse({ provider: 'gemini', field: 'model', value: 'x' })
        .success,
    ).toBe(false);
    expect(
      settingsSetCliOption.input.safeParse({
        provider: 'xai',
        field: 'model',
        value: 'x'.repeat(301),
      }).success,
    ).toBe(false);
    expect(
      settingsSetMeetingLanguage.input.safeParse({ kind: 'summary', code: 'en' }).success,
    ).toBe(true);
    expect(settingsSetMeetingLanguage.input.safeParse({ kind: 'other', code: 'en' }).success).toBe(
      false,
    );
  });

  it('model downloads and deletes answer with every outcome', () => {
    for (const out of [
      { status: 'done' },
      { status: 'cancelled' },
      { status: 'failed', message: 'HTTP 503' },
      { status: 'ignored', reason: 'already-downloading' },
    ]) {
      expect(settingsModelsDownload.output.safeParse(out).success).toBe(true);
    }
    expect(settingsModelsDelete.output.safeParse({ status: 'busy' }).success).toBe(true);
    expect(settingsModelsDelete.output.safeParse({ status: 'nope' }).success).toBe(false);
  });

  it('the locale and restart answers are closed sets', () => {
    expect(i18nGetLocale.output.safeParse({ tag: 'es', locale: 'es', saved: true }).success).toBe(
      true,
    );
    expect(i18nGetLocale.output.safeParse({ tag: 'fr', locale: 'es', saved: true }).success).toBe(
      false,
    );
    expect(appRestart.output.safeParse({ status: 'refused' }).success).toBe(true);
  });

  it('registers no xai channel and takes no xai option provider (owner decision 2026-11-03)', () => {
    expect(Object.keys(requestChannels).filter((name) => /xai/i.test(name))).toEqual([]);
    expect(
      settingsSetCliOption.input.safeParse({ provider: 'xai', field: 'model', value: 'x' }).success,
    ).toBe(false);
  });
});
