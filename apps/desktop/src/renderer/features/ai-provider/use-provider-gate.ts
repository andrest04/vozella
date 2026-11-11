import type { SummaryApiKindDto, SummaryCliKindDto } from '@vozella/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';

/** What a `needs-setup` or `unavailable` outcome from the summary service asks for. */
export interface SetupRequest {
  readonly kind: 'Local' | SummaryCliKindDto | SummaryApiKindDto | 'Xai';
  readonly reason:
    'model-missing' | 'cli-missing' | 'key-missing' | 'base-url-missing' | 'unavailable';
}

/** `completed` means the engine is ready now; anything else leaves the summary alone. */
export type RunSetup = (request: SetupRequest) => Promise<'completed' | 'cancelled'>;

/** A notice instead of a dialog: the engine was removed, or an API engine needs Settings. */
export type GateNotice =
  | { readonly type: 'removed' }
  | { readonly type: 'api-setup'; readonly kind: SummaryApiKindDto; readonly reason: string };

/** The one decision table of the gate: which surface each request opens. */
export type GateSurface =
  | { readonly surface: 'wizard' }
  | { readonly surface: 'cli'; readonly kind: SummaryCliKindDto }
  | { readonly surface: 'notice'; readonly notice: GateNotice };

export function decideSurface(request: SetupRequest): GateSurface {
  switch (request.kind) {
    case 'Local':
      return { surface: 'wizard' };
    case 'ClaudeCode':
    case 'Codex':
      return { surface: 'cli', kind: request.kind };
    // API key engines are set up in Settings (key, model, address). The notice says what is
    // missing and offers Settings; the page the user is on stays where it is.
    case 'OpenAi':
    case 'Anthropic':
    case 'Gemini':
    case 'OpenAiCompatible':
      return {
        surface: 'notice',
        notice: { type: 'api-setup', kind: request.kind, reason: request.reason },
      };
    case 'Xai':
      return { surface: 'notice', notice: { type: 'removed' } };
  }
}

type Open =
  | null
  | { readonly surface: 'wizard' }
  | { readonly surface: 'cli'; readonly kind: SummaryCliKindDto };

export interface ProviderGate {
  /** Pass to anything that can hit the gate. Resolves once the dialog is done. */
  readonly runSetup: RunSetup;
  readonly open: Open;
  /** Set after a removed provider (Xai) or an API engine that needs Settings, until dismissed. */
  readonly notice: GateNotice | null;
  readonly finish: (completed: boolean) => void;
  readonly dismissUnavailable: () => void;
  readonly openSettings: () => void;
}

/**
 * The renderer's single owner of the "this engine is not ready" answer. Local opens the setup
 * wizard on the model step; Claude Code and Codex open the CLI dialog; an API key engine that lacks
 * its key or address, and a removed provider, show a notice that points at Settings and never fall
 * back to another engine. Render the surfaces
 * with `ProviderGateDialogs`, then retry the call that was refused when `runSetup` says completed.
 */
export function useProviderGate(): ProviderGate {
  const [open, setOpen] = useState<Open>(null);
  const [notice, setNotice] = useState<GateNotice | null>(null);
  const pending = useRef<((result: 'completed' | 'cancelled') => void) | null>(null);

  const settle = useCallback((result: 'completed' | 'cancelled'): void => {
    const resolve = pending.current;
    pending.current = null;
    resolve?.(result);
  }, []);

  // A page that goes away while a dialog is open must not leave the caller waiting.
  useEffect(() => () => settle('cancelled'), [settle]);

  const runSetup = useCallback<RunSetup>((request) => {
    const decision = decideSurface(request);
    if (decision.surface === 'notice') {
      setNotice(decision.notice);
      return Promise.resolve('cancelled');
    }
    // One dialog at a time: a second request while one is open is cancelled.
    if (pending.current) return Promise.resolve('cancelled');
    return new Promise((resolve) => {
      pending.current = resolve;
      setOpen(decision);
    });
  }, []);

  const finish = useCallback(
    (completed: boolean): void => {
      setOpen(null);
      settle(completed ? 'completed' : 'cancelled');
    },
    [settle],
  );

  return {
    runSetup,
    open,
    notice,
    finish,
    dismissUnavailable: useCallback(() => {
      setNotice(null);
    }, []),
    openSettings: useCallback(() => {
      setNotice(null);
      navigateToSettings();
    }, []),
  };
}

function navigateToSettings(): void {
  void window.vozella.invoke('workspace.dispatch', {
    action: { type: 'navigateTo', tag: 'Settings' },
  });
}
