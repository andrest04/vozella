import type { ChatEngineChoicesDto, ChatEngineDto } from '@vozella/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  choiceFor,
  defaultChoice,
  isPickable,
  sendOverride,
  type ChoiceOverride,
  type ModelChoice,
} from './model-choice';

export type ModelChoiceStatus = 'loading' | 'ready' | 'failed';

export interface ModelChoiceController {
  readonly status: ModelChoiceStatus;
  readonly choices: ChatEngineChoicesDto | null;
  /** What this chat answers with: the user's pick, else the Settings default. */
  readonly choice: ModelChoice | null;
  /** Reads the choices again (the popup does it on open). A failed reload keeps the last list. */
  readonly reload: () => void;
  readonly pick: (engine: ChatEngineDto, modelId: string) => void;
  readonly setEffort: (effort: string) => void;
  /** The `chat.send` fields for this choice; empty while it is the Settings default. */
  readonly override: () => ChoiceOverride;
  /** Drops the pick (its engine stopped being ready) and reads the choices again. */
  readonly reset: () => void;
}

/** A pick survives a reload only while its engine is still offered with that model. */
function stillOffered(choices: ChatEngineChoicesDto, picked: ModelChoice): boolean {
  const entry = choices.engines.find((item) => item.engine === picked.engine);
  if (!entry || !isPickable(entry)) return false;
  return entry.models.some((model) => model.id === picked.model);
}

/**
 * The chat's model choice for one conversation. It lives in the chat body, so New chat (which
 * remounts the body) starts again from Settings. It never writes Settings.
 */
export function useModelChoice(): ModelChoiceController {
  const [status, setStatus] = useState<ModelChoiceStatus>('loading');
  const [choices, setChoices] = useState<ChatEngineChoicesDto | null>(null);
  const [picked, setPicked] = useState<ModelChoice | null>(null);
  const latest = useRef({ choices, picked });
  latest.current = { choices, picked };
  const generation = useRef(0);

  const reload = useCallback((): void => {
    const run = ++generation.current;
    void window.vozella
      .invoke('chat.getEngineChoices', {})
      .then((next) => {
        if (run !== generation.current) return;
        setChoices(next);
        setStatus('ready');
        setPicked((current) => (current && stillOffered(next, current) ? current : null));
      })
      .catch(() => {
        if (run !== generation.current) return;
        // The chip hides only when nothing ever loaded; sends then use Settings as before.
        setStatus((current) => (current === 'ready' ? current : 'failed'));
      });
  }, []);

  useEffect(() => {
    reload();
    return () => {
      generation.current += 1;
    };
  }, [reload]);

  const choice = picked ?? (choices ? defaultChoice(choices) : null);

  const pick = useCallback((engine: ChatEngineDto, modelId: string): void => {
    const entry = latest.current.choices?.engines.find((item) => item.engine === engine);
    if (!entry) return;
    const current =
      latest.current.picked ??
      (latest.current.choices ? defaultChoice(latest.current.choices) : null);
    setPicked(choiceFor(entry, modelId, current));
  }, []);

  const setEffort = useCallback((effort: string): void => {
    const { choices: list, picked: current } = latest.current;
    const base = current ?? (list ? defaultChoice(list) : null);
    if (!base) return;
    setPicked({ ...base, effort });
  }, []);

  const override = useCallback(
    (): ChoiceOverride =>
      sendOverride(
        latest.current.picked ??
          (latest.current.choices ? defaultChoice(latest.current.choices) : null),
        latest.current.choices,
      ),
    [],
  );

  const reset = useCallback((): void => {
    setPicked(null);
    reload();
  }, [reload]);

  return { status, choices, choice, reload, pick, setEffort, override, reset };
}
