import {
  CURSOR_TYPING_SOURCES,
  DEFAULT_CURSOR_TYPING_SHORTCUT,
  resolveCursorTypingShortcut,
  resolveCursorTypingSource,
  type AppSettings,
} from '@vozella/core';
import { CircleAlert } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useT } from '../../i18n/I18nProvider';
import type { StringKey } from '../../i18n/translate';
import { Button, Icon, SectionHeader, Select, SettingRow, Switch } from '../../ui';
import { acceleratorLabel } from '../cursor-typing/cursor-typing-text';
import { ShortcutCapture, type ShortcutProblem } from '../cursor-typing/ShortcutCapture';
import { useCursorTypingStatus } from '../cursor-typing/use-cursor-typing-status';

type Source = (typeof CURSOR_TYPING_SOURCES)[number];

interface Prefs {
  readonly enabled: boolean;
  readonly shortcut: string;
  readonly source: Source;
}

type CursorTypingFields = Pick<
  AppSettings,
  'cursorTypingEnabled' | 'cursorTypingShortcut' | 'cursorTypingSource'
>;

const fromSettings = (settings: CursorTypingFields): Prefs => ({
  enabled: settings.cursorTypingEnabled,
  shortcut: resolveCursorTypingShortcut(settings),
  source: resolveCursorTypingSource(settings),
});

const SOURCE_LABELS: Record<Source, StringKey> = {
  others: 'Ui_CursorTypingSourceOthers',
  all: 'Ui_CursorTypingSourceAll',
};

const PROBLEMS: Record<ShortcutProblem, StringKey> = {
  'needs-modifier': 'Ui_CursorTypingShortcutNeedsModifier',
  unsupported: 'Ui_CursorTypingShortcutUnsupported',
};

const isSource = (value: string): value is Source =>
  (CURSOR_TYPING_SOURCES as readonly string[]).includes(value);

/**
 * Type at cursor in Settings: the switch, the shortcut, which lines are typed, and what it cannot
 * do. It reads the saved fields and writes only the one that changed; unset fields show their
 * defaults and are not written. The shortcut row follows main's status, so a combination another
 * app holds is named while a take records.
 */
export function CursorTypingSection() {
  const t = useT();
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [problem, setProblem] = useState<ShortcutProblem | null>(null);
  const status = useCursorTypingStatus();
  const problemId = useId();
  const alive = useRef(true);

  const read = useCallback(async () => {
    try {
      const settings = await window.vozella.invoke('settings.get', {});
      if (alive.current) setPrefs(fromSettings(settings));
    } catch {
      // The controls stay disabled until a read works.
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void read();
    return () => {
      alive.current = false;
    };
  }, [read]);

  const save = (patch: Partial<CursorTypingFields>, optimistic: Prefs): void => {
    setPrefs(optimistic);
    window.vozella
      .invoke('settings.update', { patch })
      .then(
        (saved) => {
          if (alive.current) setPrefs(fromSettings(saved));
        },
        () => read(),
      )
      .catch(() => undefined);
  };

  const off = !prefs?.enabled;
  const custom = prefs !== null && prefs.shortcut !== DEFAULT_CURSOR_TYPING_SHORTCUT;
  const taken =
    prefs !== null &&
    status?.shortcut.status === 'unavailable' &&
    status.shortcut.accelerator === prefs.shortcut;
  const shortcutError =
    problem !== null
      ? t(PROBLEMS[problem])
      : taken
        ? t('Ui_CursorTypingShortcutTaken', acceleratorLabel(prefs.shortcut))
        : null;

  return (
    <div data-testid="cursor-typing-section">
      <SectionHeader level={2} compact title={t('Ui_CursorTypingHeader')} className="pb-2" />
      <SettingRow title={t('Ui_CursorTypingToggle')} description={t('Ui_CursorTypingDescription')}>
        {({ titleId }) => (
          <Switch
            id="ToggleCursorTyping"
            aria-labelledby={titleId}
            label={prefs?.enabled ? t('Ui_SwitchOn') : t('Ui_SwitchOff')}
            checked={prefs?.enabled ?? false}
            disabled={prefs === null}
            onCheckedChange={(enabled) => {
              if (prefs) save({ cursorTypingEnabled: enabled }, { ...prefs, enabled });
            }}
          />
        )}
      </SettingRow>
      <SettingRow
        title={t('Ui_CursorTypingShortcut')}
        description={
          <span className="flex flex-col gap-1">
            <span>{t('Ui_CursorTypingShortcutDescription')}</span>
            {/* Always mounted, so a refused combination or a taken shortcut is announced. */}
            <span id={problemId} role="status" data-testid="cursor-typing-shortcut-error">
              {shortcutError !== null ? (
                <span className="flex items-start gap-1.5 text-ink">
                  <Icon icon={CircleAlert} size={14} className="mt-[3px]" />
                  {shortcutError}
                </span>
              ) : null}
            </span>
          </span>
        }
      >
        {custom ? (
          <Button
            variant="quiet"
            size="sm"
            data-testid="BtnCursorTypingShortcutReset"
            disabled={off}
            onClick={() => {
              save(
                { cursorTypingShortcut: null },
                { ...prefs, shortcut: DEFAULT_CURSOR_TYPING_SHORTCUT },
              );
            }}
          >
            {t('Ui_CursorTypingShortcutReset')}
          </Button>
        ) : null}
        <ShortcutCapture
          accelerator={prefs?.shortcut ?? DEFAULT_CURSOR_TYPING_SHORTCUT}
          disabled={off}
          changeLabel={t(
            'Ui_CursorTypingShortcutChange',
            acceleratorLabel(prefs?.shortcut ?? DEFAULT_CURSOR_TYPING_SHORTCUT),
          )}
          captureLabel={t('Ui_CursorTypingShortcutCaptureName')}
          prompt={t('Ui_CursorTypingShortcutPrompt')}
          problemId={problemId}
          problem={problem}
          onProblem={setProblem}
          onCapture={(shortcut) => {
            if (prefs && shortcut !== prefs.shortcut) {
              save({ cursorTypingShortcut: shortcut }, { ...prefs, shortcut });
            }
          }}
        />
      </SettingRow>
      <SettingRow
        title={t('Ui_CursorTypingSource')}
        description={t('Ui_CursorTypingSourceDescription')}
      >
        <Select
          testId="SelectCursorTypingSource"
          label={t('Ui_CursorTypingSource')}
          value={prefs?.source ?? null}
          disabled={off}
          options={CURSOR_TYPING_SOURCES.map((value) => ({
            value,
            label: t(SOURCE_LABELS[value]),
          }))}
          onValueChange={(value) => {
            if (prefs && isSource(value) && value !== prefs.source) {
              save({ cursorTypingSource: value }, { ...prefs, source: value });
            }
          }}
        />
      </SettingRow>
      <p className="max-w-prose pt-3 text-ui text-ink-muted">{t('Ui_CursorTypingAdminLimit')}</p>
    </div>
  );
}
