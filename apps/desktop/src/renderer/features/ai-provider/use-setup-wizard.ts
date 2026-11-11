import { useCallback, useEffect, useReducer, useRef } from 'react';
import {
  initialWizardState,
  wizardReducer,
  type WizardEngine,
  type WizardMode,
  type WizardResult,
  type WizardState,
} from './wizard-state';

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export interface SetupWizard {
  readonly state: WizardState;
  readonly chooseEngine: (engine: WizardEngine) => void;
  readonly back: () => void;
  readonly retryHardware: () => void;
  readonly select: (fileName: string) => void;
  /** Downloads the chosen model, or just saves it when it is already on disk. */
  readonly chooseModel: (fileName: string) => void;
  /** Stops the transfer and returns to the list. Nothing is saved. */
  readonly cancelDownload: () => void;
  /** The CLI panel (S19) calls this when its executable is found and saved. */
  readonly cliReady: () => void;
  /** Closes the wizard: cancels a running transfer and reports no result. */
  readonly close: () => void;
}

/**
 * Drives the Summary setup wizard: the pure reducer decides the phases, this hook sends the
 * requests and feeds the answers back under the attempt they were sent with, so an answer that
 * comes after a cancel or a close is dropped. `onFinished` is called once: with the engine that
 * is ready, or with null when the user leaves. `onSentToSettings` runs just before that null when
 * an API engine still needs its key and the wizard opens Settings for it.
 */
export function useSetupWizard(
  mode: WizardMode,
  onFinished: (result: WizardResult | null) => void,
  onSentToSettings?: () => void,
): SetupWizard {
  const [state, dispatch] = useReducer(wizardReducer, mode, initialWizardState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const finishedRef = useRef(onFinished);
  finishedRef.current = onFinished;
  const sentToSettingsRef = useRef(onSentToSettings);
  sentToSettingsRef.current = onSentToSettings;
  const reported = useRef(false);

  const report = useCallback((result: WizardResult | null): void => {
    if (reported.current) return;
    reported.current = true;
    finishedRef.current(result);
  }, []);

  // Hardware detection runs whenever the wizard is on that phase without an error. The attempt
  // travels with the request; a later attempt or a close makes the answer stale in the reducer.
  const detecting = state.phase === 'DetectingHardware' && state.error === null;
  const detectAttempt = state.attempt;
  useEffect(() => {
    if (!detecting) return;
    void window.vozella
      .invoke('summaries.hardware', {})
      .then((answer) => {
        dispatch({
          type: 'hardwareLoaded',
          attempt: detectAttempt,
          hardware: answer.hardware,
          rows: answer.rows,
          defaultFileName: answer.defaultFileName,
        });
      })
      .catch((error: unknown) => {
        dispatch({ type: 'hardwareFailed', attempt: detectAttempt, message: messageOf(error) });
      });
  }, [detecting, detectAttempt]);

  useEffect(
    () =>
      window.vozella.on('settings.modelEvent', (event) => {
        if (event.type === 'progress') {
          dispatch({ type: 'progress', fileName: event.fileName, percent: event.percent });
        }
      }),
    [],
  );

  // An API key engine: save it as the summary engine, then ask main whether it can answer. A key
  // that is still missing sends the user to Settings, where the key is entered (BYOK).
  const savingApi = state.phase === 'SavingApi' ? state.api : null;
  const saveAttempt = state.attempt;
  useEffect(() => {
    if (savingApi === null) return;
    const needsSettings = (): void => {
      // The user may have closed the wizard meanwhile: then nothing moves.
      const current = stateRef.current;
      if (current.phase !== 'SavingApi' || current.attempt !== saveAttempt) return;
      dispatch({ type: 'apiNeedsSettings', attempt: saveAttempt });
      // Told before `onFinished(null)`, so a caller can tell "went to Settings" from "left".
      if (!reported.current) sentToSettingsRef.current?.();
      report(null);
      void window.vozella
        .invoke('workspace.dispatch', { action: { type: 'navigateTo', tag: 'Settings' } })
        .catch(() => undefined);
    };
    void window.vozella
      .invoke('settings.setSummaryProvider', { kind: savingApi })
      .then(() => window.vozella.invoke('summaries.providerStatus', {}))
      .then((status) => {
        if (status.status === 'ready' && status.kind === savingApi) {
          dispatch({ type: 'apiReady', attempt: saveAttempt });
        } else {
          needsSettings();
        }
      })
      .catch(needsSettings);
  }, [savingApi, saveAttempt, report]);

  useEffect(() => {
    if (state.phase === 'Completed') report(state.result);
  }, [state, report]);

  const chooseModel = useCallback((fileName: string): void => {
    const current = stateRef.current;
    if (current.phase !== 'SelectingModel' || current.busy) return;
    const row = current.rows.find((candidate) => candidate.fileName === fileName);
    const attempt = current.attempt + 1;
    dispatch(
      row?.downloaded === true
        ? { type: 'startSave', fileName }
        : { type: 'startDownload', fileName },
    );
    void window.vozella
      .invoke('summaries.chooseLocalModel', { fileName })
      .then((answer) => {
        switch (answer.status) {
          case 'saved':
            dispatch({ type: 'downloadSaved', attempt, fileName });
            break;
          case 'failed':
            dispatch({ type: 'downloadFailed', attempt, message: answer.message });
            break;
          case 'ignored':
            dispatch({ type: 'downloadFailed', attempt, message: answer.reason });
            break;
          case 'cancelled':
            // Cancelled from somewhere else (Settings): the list comes back without an error.
            dispatch({ type: 'downloadCancelled', attempt });
            break;
        }
      })
      .catch((error: unknown) => {
        dispatch({ type: 'downloadFailed', attempt, message: messageOf(error) });
      });
  }, []);

  const cancelDownload = useCallback((): void => {
    const current = stateRef.current;
    if (current.phase !== 'Downloading') return;
    dispatch({ type: 'cancelDownload' });
    void window.vozella
      .invoke('summaries.cancelLocalModel', { fileName: current.fileName })
      .catch(() => undefined);
  }, []);

  const close = useCallback((): void => {
    const current = stateRef.current;
    if (current.phase === 'Downloading') {
      void window.vozella
        .invoke('summaries.cancelLocalModel', { fileName: current.fileName })
        .catch(() => undefined);
    }
    dispatch({ type: 'close' });
    report(null);
  }, [report]);

  return {
    state,
    chooseEngine: useCallback((engine) => {
      dispatch({ type: 'chooseEngine', engine });
    }, []),
    back: useCallback(() => {
      dispatch({ type: 'back' });
    }, []),
    retryHardware: useCallback(() => {
      dispatch({ type: 'retryHardware' });
    }, []),
    select: useCallback((fileName) => {
      dispatch({ type: 'select', fileName });
    }, []),
    chooseModel,
    cancelDownload,
    cliReady: useCallback(() => {
      dispatch({ type: 'cliReady' });
    }, []),
    close,
  };
}
