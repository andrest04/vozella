import { Radio } from '@base-ui/react/radio';
import { RadioGroup as BaseRadioGroup } from '@base-ui/react/radio-group';
import type { SummaryProviderDto } from '@vozella/contracts';
import { useId, type ReactNode } from 'react';
import { useT } from '../../i18n/I18nProvider';
import type { StringKey } from '../../i18n/translate';
import { cn } from '../../ui';
import { ProviderMark } from '../ai-provider/ProviderMark';

type Choice = Exclude<SummaryProviderDto, 'Xai'>;

/**
 * The engines in three groups, by what the user brings: nothing (this PC), a subscription and its
 * CLI, or their own API key. The order inside a group is fixed; Grok is not offered.
 */
const GROUPS: readonly {
  readonly caption: StringKey;
  readonly choices: readonly { readonly kind: Choice; readonly name: StringKey }[];
}[] = [
  {
    caption: 'Ui_ProviderGroupDevice',
    choices: [{ kind: 'Local', name: 'Settings_ProviderLocal.Text' }],
  },
  {
    caption: 'Ui_ProviderGroupSubscription',
    choices: [
      { kind: 'ClaudeCode', name: 'Settings_ProviderClaude.Text' },
      { kind: 'Codex', name: 'Settings_ProviderCodex.Text' },
    ],
  },
  {
    caption: 'Ui_ProviderGroupApiKey',
    choices: [
      { kind: 'OpenAi', name: 'Ui_ApiOpenAiName' },
      { kind: 'Anthropic', name: 'Ui_ApiAnthropicName' },
      { kind: 'Gemini', name: 'Ui_ApiGeminiName' },
      { kind: 'OpenAiCompatible', name: 'Ui_ApiOpenAiCompatibleName' },
    ],
  },
];

function ChoiceRadio({
  kind,
  name,
  describedBy,
}: {
  readonly kind: Choice;
  readonly name: string;
  readonly describedBy: string;
}): ReactNode {
  return (
    <label className="flex min-w-0 items-start gap-2.5 text-ui-lg text-ink">
      <Radio.Root
        value={kind}
        aria-describedby={describedBy}
        className={cn(
          'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-border-control bg-paper',
          'transition-colors duration-150 ease-out-quick',
          'data-checked:border-ink data-disabled:cursor-not-allowed data-disabled:opacity-50',
          'forced-colors:data-checked:border-[Highlight]',
        )}
      >
        <Radio.Indicator className="block size-2 rounded-full bg-ink forced-colors:bg-[Highlight]" />
      </Radio.Root>
      <span className="inline-flex items-center gap-2">
        <ProviderMark kind={kind} />
        {name}
      </span>
    </label>
  );
}

/**
 * One radio group for the summary engine, drawn as three labelled rows. It stays a single group,
 * so arrow keys move across every engine and the choice is one value; each radio is described by
 * its row's caption so a screen reader hears the group too.
 */
export function ProviderChoice({
  value,
  label,
  onValueChange,
}: {
  /** Empty when nothing is selected (a saved provider that no longer exists). */
  readonly value: string;
  readonly label: string;
  readonly onValueChange: (kind: string) => void;
}): ReactNode {
  const t = useT();
  const baseId = useId();
  return (
    <BaseRadioGroup
      aria-label={label}
      value={value}
      onValueChange={(next) => {
        if (typeof next === 'string') onValueChange(next);
      }}
      className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] gap-x-6 gap-y-3"
    >
      {GROUPS.map((group, index) => {
        const captionId = `${baseId}-group-${String(index)}`;
        return (
          <div key={group.caption} className="contents">
            <span id={captionId} className="pt-px text-ui text-ink-muted">
              {t(group.caption)}
            </span>
            <div className="flex flex-wrap gap-x-5 gap-y-2.5">
              {group.choices.map((choice) => (
                <ChoiceRadio
                  key={choice.kind}
                  kind={choice.kind}
                  name={t(choice.name)}
                  describedBy={captionId}
                />
              ))}
            </div>
          </div>
        );
      })}
    </BaseRadioGroup>
  );
}
