import { isApiProvider } from '../library/settings';
import { API_ENGINES } from '../settings/api-providers';
import { CLI_ENGINES } from '../settings/cli-providers';
import {
  cloudTranscriptionProvider,
  isCloudTranscriptionKind,
} from '../settings/cloud-transcription-engines';
import { findSummaryModel } from '../settings/summary-models';
import type { Readiness, SetupFacts } from './readiness';

/** What the setup checklist and the idle status show. Keys and args, never finished strings. */

export interface TextRef {
  readonly key: string;
  readonly args: readonly string[];
}

export interface SetupCard {
  readonly headerKey: string;
  readonly status: TextRef;
  readonly detail: TextRef;
  readonly ready: boolean;
  /**
   * Why the card is not ready, when the wording of `detail` is not enough for the page to act on:
   * `key-missing` is a cloud transcription engine without its API key, which is fixed in Settings
   * and not by a download. Absent otherwise.
   */
  readonly reason?: SetupCardReason;
}

export type SetupCardReason = 'key-missing';

export interface SetupSnapshot {
  readonly canRecord: boolean;
  readonly live: SetupCard;
  readonly engine: SetupCard;
  readonly summary: SetupCard;
  /** The xAI provider is gone but the settings file still selects it: ask for another one. */
  readonly summaryProviderRemoved: boolean;
  /** Shown only when idle. */
  readonly idleStatus: TextRef;
}

const ref = (key: string, ...args: string[]): TextRef => ({ key, args });

/** The summary caption. `Xai` and anything unknown read as "Not chosen". */
export function summaryCaption(provider: SetupFacts['provider'], modelId: string | null): TextRef {
  switch (provider) {
    case 'Local': {
      const model = findSummaryModel(modelId);
      return model === null
        ? ref('RecordingSetup_SummaryLocal')
        : ref('RecordingSetup_SummaryLocalModel', model.displayName);
    }
    case 'ClaudeCode':
    case 'Codex':
      return ref(CLI_ENGINES[provider].nameKey);
    default:
      return isApiProvider(provider)
        ? ref(API_ENGINES[provider].nameKey)
        : ref('RecordingSetup_SummaryNotChosen');
  }
}

const statusRef = (ready: boolean): TextRef =>
  ref(ready ? 'RecordingSetup_Ready' : 'RecordingSetup_NeedsSetup');

/**
 * The engine card. The only thing a cloud engine can be missing is the key of its provider (an
 * API engine, or one that only transcribes), so one that is not ready says which provider needs
 * one; with the key stored it is ready like the engine on this PC.
 */
function engineCard(facts: SetupFacts, readiness: Readiness): SetupCard {
  const card: SetupCard = {
    headerKey: 'RecordingSetup_Engine.Header',
    status: statusRef(readiness.engineReady),
    detail: ref('RecordingSetup_EngineDetail'),
    ready: readiness.engineReady,
  };
  const engine = facts.transcriptionEngine;
  if (readiness.engineReady || !isCloudTranscriptionKind(engine)) return card;
  return {
    ...card,
    detail: ref('Ui_ApiKeyMissing', cloudTranscriptionProvider(engine).displayName),
    reason: 'key-missing',
  };
}

export function buildSetupSnapshot(facts: SetupFacts, readiness: Readiness): SetupSnapshot {
  return {
    canRecord: readiness.canRecord,
    live: {
      headerKey: 'RecordingSetup_Live.Header',
      status: readiness.liveRequired
        ? statusRef(readiness.liveReady)
        : ref('RecordingSetup_NotNeeded'),
      detail: ref(
        readiness.liveRequired ? 'RecordingSetup_LiveDetail' : 'RecordingSetup_LiveNotNeededDetail',
      ),
      ready: readiness.liveReady,
    },
    engine: engineCard(facts, readiness),
    summary: {
      headerKey: 'RecordingSetup_Summary.Header',
      status: statusRef(readiness.summaryReady),
      detail: summaryCaption(facts.provider, facts.summaryModelId),
      ready: readiness.summaryReady,
    },
    summaryProviderRemoved: facts.summaryProviderRemoved,
    idleStatus: ref(readiness.canRecord ? 'Status_ReadyToRecord' : 'Status_NeedsSetup'),
  };
}
