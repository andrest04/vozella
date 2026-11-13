import {
  isApiProvider,
  isCliProvider,
  type AppSettings,
  type SummaryProviderKind,
} from '../library/settings';
import { API_ENGINES } from '../settings/api-providers';
import { CLI_ENGINES } from '../settings/cli-providers';

/**
 * A model and effort picked for one request (the chat's model picker). It is never saved: the
 * engine reads it in place of the Settings values for that request only.
 */
export interface ModelChoice {
  /** CLI: a model alias the engine offers. API: a model id. Local: a catalog model file name. */
  readonly model?: string;
  /** CLI only: an effort level the engine offers. Ignored by API engines and Local. */
  readonly effort?: string;
}

const hasNoWhitespace = (value: string): boolean => value !== '' && !/\s/.test(value);

/**
 * The settings snapshot one request reads, with the choice laid over it. Only values the engine
 * can use are applied; anything else keeps the Settings value. The result is a copy: nothing here
 * writes Settings. Local is checked by the caller (the file must be on disk), so its model id is
 * passed through as is.
 */
export function withModelChoice(
  kind: SummaryProviderKind,
  settings: AppSettings,
  choice: ModelChoice | undefined,
): AppSettings {
  if (choice === undefined) return settings;
  const { model, effort } = choice;
  if (kind === 'Local') {
    return model === undefined ? settings : { ...settings, selectedSummaryModelId: model };
  }
  if (isApiProvider(kind)) {
    const id = model?.trim() ?? '';
    return hasNoWhitespace(id) ? { ...settings, [API_ENGINES[kind].modelSetting]: id } : settings;
  }
  if (!isCliProvider(kind)) return settings;
  const engine = CLI_ENGINES[kind];
  const offers = (options: readonly string[], value: string | undefined): value is string =>
    value !== undefined && options.includes(value);
  let next = settings;
  if (offers(engine.models, model)) next = { ...next, [engine.modelSetting]: model };
  if (offers(engine.efforts, effort)) next = { ...next, [engine.effortSetting]: effort };
  return next;
}
