import { resolveUiLanguage, UI_LANGUAGE_TAGS } from '../i18n/ui-language';
import {
  resolveSummaryProviderKind,
  isProviderAvailable,
  SUMMARY_PROVIDERS,
  type AppSettings,
  type SettingsStore,
} from '../library';
import { cliEngineByExecutable, type CliExecutable } from './cli-providers';
import {
  normalizeLanguageCode,
  resolveMeetingLanguageCode,
  resolveSummaryLanguageCode,
  SUMMARY_LANGUAGES,
  TRANSCRIPTION_LANGUAGES,
} from './languages';

/** A line for the shared success bar. The UI turns `key` and `args` into text in its language. */
export interface Feedback {
  readonly key: 'Xai_FeedbackModel';
  readonly args: readonly string[];
}

export type IgnoredReason = 'blank' | 'unchanged' | 'invalid';

/**
 * What a settings change did. Failures are values: the page shows them, nothing is thrown at an
 * event handler (B12).
 */
export type CommitOutcome =
  | { readonly status: 'saved'; readonly settings: AppSettings; readonly feedback: Feedback | null }
  | { readonly status: 'ignored'; readonly reason: IgnoredReason }
  | { readonly status: 'failed'; readonly message: string };

export const ignored = (reason: IgnoredReason): CommitOutcome => ({ status: 'ignored', reason });

export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The model and effort pickers are keyed by the engine's executable name. */
export type CliOptionProvider = CliExecutable;
export type CliOptionField = 'model' | 'effort';

export interface SettingsCommandsDeps {
  readonly store: SettingsStore;
  /** The OS preferred languages, for what the app language picker shows when nothing is saved. */
  readonly osLanguages: () => readonly string[];
}

/** The `model · effort` text of the shared feedback bar, with a middle dot. */
const modelAndEffort = (model: string, effort: string): string => `${model} · ${effort}`;

/**
 * The single place the Settings page changes the fields it owns. Every change is a patch applied
 * under the store's lock, so sections cannot overwrite each other (B1). A change that is blank,
 * unchanged or not one of the offered choices is ignored, as the page ignores such events.
 */
export class SettingsCommands {
  constructor(private readonly deps: SettingsCommandsDeps) {}

  /** `en-US` or `es`, compared with what the picker shows now. */
  async setUiLanguage(tag: string): Promise<CommitOutcome> {
    return this.commit((current) => {
      if (!(UI_LANGUAGE_TAGS as readonly string[]).includes(tag)) return ignored('invalid');
      const shown = resolveUiLanguage(current.uiLanguage, this.deps.osLanguages());
      if (shown === tag) return ignored('unchanged');
      return { patch: { uiLanguage: tag } };
    });
  }

  /** The exact enum name only (B2). A removed provider (Xai) is refused, so the page cannot select it again. */
  async setSummaryProvider(kind: string): Promise<CommitOutcome> {
    return this.commit((current) => {
      if (!(SUMMARY_PROVIDERS as readonly string[]).includes(kind)) return ignored('invalid');
      if (!isProviderAvailable(kind as (typeof SUMMARY_PROVIDERS)[number]))
        return ignored('invalid');
      if (resolveSummaryProviderKind(current) === kind) return ignored('unchanged');
      return { patch: { selectedSummaryProvider: kind } };
    });
  }

  async setCliOption(input: {
    readonly provider: CliOptionProvider;
    readonly field: CliOptionField;
    readonly value: string;
  }): Promise<CommitOutcome> {
    const { provider, field, value } = input;
    return this.commit((current) => {
      if (value.trim() === '') return ignored('blank');
      // The stored value counts as offered even when hand edited out of the list (B13).
      if (this.currentValue(current, provider, field) === value) return ignored('unchanged');
      const allowed = this.choices(provider, field);
      if (!allowed.includes(value)) return ignored('invalid');
      return {
        patch: this.patchFor(provider, field, value),
        feedback: (next) => this.feedbackFor(next, provider),
      };
    });
  }

  /** `transcription` or `summary`, with the code of that picker's catalog. */
  async setMeetingLanguage(
    kind: 'transcription' | 'summary',
    code: string,
  ): Promise<CommitOutcome> {
    const catalog = kind === 'transcription' ? TRANSCRIPTION_LANGUAGES : SUMMARY_LANGUAGES;
    return this.commit((current) => {
      const wanted = normalizeLanguageCode(code);
      if (!catalog.some((entry) => entry.code === wanted)) return ignored('invalid');
      const shown =
        kind === 'transcription'
          ? resolveMeetingLanguageCode(current.transcriptionLanguage)
          : resolveSummaryLanguageCode(current.summaryLanguage);
      if (shown === wanted) return ignored('unchanged');
      return {
        patch:
          kind === 'transcription'
            ? { transcriptionLanguage: wanted }
            : { summaryLanguage: wanted },
      };
    });
  }

  private choices(provider: CliOptionProvider, field: CliOptionField): readonly string[] {
    const engine = cliEngineByExecutable(provider);
    return field === 'model' ? engine.models : engine.efforts;
  }

  private currentValue(
    s: AppSettings,
    provider: CliOptionProvider,
    field: CliOptionField,
  ): string | null {
    const engine = cliEngineByExecutable(provider);
    return field === 'model' ? engine.resolveModel(s) : engine.resolveEffort(s);
  }

  private patchFor(
    provider: CliOptionProvider,
    field: CliOptionField,
    value: string,
  ): Partial<AppSettings> {
    const engine = cliEngineByExecutable(provider);
    return { [field === 'model' ? engine.modelSetting : engine.effortSetting]: value };
  }

  private feedbackFor(next: AppSettings, provider: CliOptionProvider): Feedback | null {
    const engine = cliEngineByExecutable(provider);
    return {
      key: 'Xai_FeedbackModel',
      args: [modelAndEffort(engine.resolveModel(next), engine.resolveEffort(next))],
    };
  }

  /** Reads the fresh blob, lets `decide` accept or ignore, then applies the patch under the lock. */
  private async commit(
    decide: (
      current: AppSettings,
    ) =>
      | CommitOutcome
      | { patch: Partial<AppSettings>; feedback?: (next: AppSettings) => Feedback | null }
      | Promise<
          | CommitOutcome
          | { patch: Partial<AppSettings>; feedback?: (next: AppSettings) => Feedback | null }
        >,
  ): Promise<CommitOutcome> {
    try {
      const current = await this.deps.store.load();
      const decision = await decide(current);
      if ('status' in decision) return decision;
      const settings = await this.deps.store.update(decision.patch);
      return { status: 'saved', settings, feedback: decision.feedback?.(settings) ?? null };
    } catch (error) {
      return { status: 'failed', message: messageOf(error) };
    }
  }
}
