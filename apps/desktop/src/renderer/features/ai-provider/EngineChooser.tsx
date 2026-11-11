import type { ReactNode } from 'react';
import { useT } from '../../i18n/I18nProvider';
import { cn } from '../../ui';
import { ProviderMark } from './ProviderMark';
import { API_KINDS, API_NAME_KEYS } from './api-engines';
import type { WizardEngine } from './wizard-state';

/** Rows in the order the spec fixes (item 127). Grok is not offered: owner decision 2026-11-03. */
const ENGINES = [
  { engine: 'ClaudeCode', name: 'Setup_ClaudeName.Text', hint: 'Setup_ClaudeHint.Text' },
  { engine: 'Codex', name: 'Setup_CodexName.Text', hint: 'Setup_CodexHint.Text' },
  { engine: 'Local', name: 'Setup_LocalName.Text', hint: 'Setup_LocalHint.Text' },
] as const;

const LIST =
  'flex flex-col overflow-hidden rounded-control border border-hairline forced-colors:border-[CanvasText]';

function EngineRow({
  engine,
  name,
  hint,
  onChoose,
}: {
  readonly engine: WizardEngine;
  readonly name: string;
  readonly hint: string | null;
  readonly onChoose: (engine: WizardEngine) => void;
}): ReactNode {
  return (
    <li className="border-b border-hairline last:border-b-0">
      <button
        type="button"
        data-testid={`BtnEngine${engine}`}
        onClick={() => {
          onChoose(engine);
        }}
        className={cn(
          'flex w-full items-start gap-3 px-3 py-2.5 text-start',
          'transition-colors duration-150 ease-out-quick hover:bg-hover active:bg-pressed',
        )}
      >
        <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center">
          <ProviderMark kind={engine} />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="text-ui-lg font-medium text-ink">{name}</span>
          {hint ? <span className="text-ui text-ink-muted">{hint}</span> : null}
        </span>
      </button>
    </li>
  );
}

/**
 * The first panel: pick the engine that turns a transcript into a summary. The API key engines
 * (BYOK) follow in their own list; picking one saves it and, while its key is missing, opens
 * Settings to add it.
 */
export function EngineChooser({
  onChoose,
}: {
  readonly onChoose: (engine: WizardEngine) => void;
}): ReactNode {
  const t = useT();
  return (
    <section className="flex flex-col gap-3" aria-labelledby="wizard-choose-heading">
      <div className="flex flex-col gap-0.5">
        <h3 id="wizard-choose-heading" className="text-ui-lg font-medium text-ink">
          {t('Setup_ChooseEngine.Text')}
        </h3>
        <p className="text-ui text-ink-muted">{t('Setup_ChooseEngineHint.Text')}</p>
      </div>
      <ul className={LIST}>
        {ENGINES.map(({ engine, name, hint }) => (
          <EngineRow
            key={engine}
            engine={engine}
            name={t(name)}
            hint={t(hint)}
            onChoose={onChoose}
          />
        ))}
      </ul>
      <div className="flex flex-col gap-0.5 pt-1">
        <h4 id="wizard-api-heading" className="text-ui font-medium text-ink">
          {t('Ui_SetupApiGroup')}
        </h4>
        <p className="text-ui text-ink-muted">{t('Ui_SetupApiHint')}</p>
      </div>
      <ul className={LIST} aria-labelledby="wizard-api-heading">
        {API_KINDS.map((kind) => (
          <EngineRow
            key={kind}
            engine={kind}
            name={t(API_NAME_KEYS[kind])}
            hint={null}
            onChoose={onChoose}
          />
        ))}
      </ul>
    </section>
  );
}
