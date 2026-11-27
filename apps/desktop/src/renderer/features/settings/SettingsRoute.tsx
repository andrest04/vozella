import { SETTINGS_SECTIONS, SETTINGS_TABS, type SettingsSectionId } from '@vozella/core';
import { Fragment, useRef, type ReactNode } from 'react';
import { useT } from '../../i18n/I18nProvider';
import { useTheme, isThemePreference } from '../../app/theme';
import {
  Button,
  Notice,
  RadioGroup,
  SectionHeader,
  SettingRow,
  SkeletonText,
  Tabs,
  type TabItem,
} from '../../ui';
import { MicrophoneSection } from '../audio/MicrophoneSection';
import { AboutSection } from './AboutSection';
import { CallDetectionSection } from './CallDetectionSection';
import { DataSection } from './DataSection';
import { LanguageSection } from './LanguageSection';
import { CursorTypingSection } from './CursorTypingSection';
import { CustomTemplateSection } from './CustomTemplateSection';
import { LiveQuestionsSection } from './LiveQuestionsSection';
import { MeetingLanguageSection } from './MeetingLanguageSection';
import { ProviderSection } from './ProviderSection';
import { StartupSection } from './StartupSection';
import { TranscriptionSection } from '../transcription/TranscriptionSection';
import { useSettingsPage } from './use-settings-page';
import { useSettingsTab } from './settings-tab';

function AppearanceSection() {
  const t = useT();
  const { preference, setPreference } = useTheme();
  return (
    <div>
      <SectionHeader level={2} compact title={t('Ui_Appearance')} className="pb-2" />
      <SettingRow title={t('Ui_Theme')} description={t('Ui_ThemeDescription')}>
        <RadioGroup
          label={t('Ui_Theme')}
          orientation="horizontal"
          value={preference}
          onValueChange={(next) => {
            if (isThemePreference(next)) setPreference(next);
          }}
          options={[
            { value: 'system', label: t('Ui_ThemeSystem') },
            { value: 'light', label: t('Ui_ThemeLight') },
            { value: 'dark', label: t('Ui_ThemeDark') },
          ]}
        />
      </SettingRow>
    </div>
  );
}

/**
 * The Settings page. The blocks follow `SETTINGS_SECTIONS`, in meeting lifecycle order, grouped
 * into the tabs of `SETTINGS_TABS` so one short group is on screen at a time; a block whose module
 * has not landed is not drawn, and nothing stands in for it. Appearance needs no page answer, so
 * it stays reachable, without tabs, while the page loads or fails.
 */
export function SettingsRoute() {
  const t = useT();
  const model = useSettingsPage();
  const { page } = model;
  const [tab, setTab] = useSettingsTab();
  // The fade belongs to the first reveal; a revisit paints the kept snapshot silently.
  const revealed = useRef(model.page === null).current;
  const appearanceBuilt = SETTINGS_SECTIONS.some(
    (section) => section.id === 'appearance' && section.status === 'built',
  );

  const renderBlock = (id: SettingsSectionId): ReactNode => {
    if (!page) return null;
    switch (id) {
      case 'language':
        return <LanguageSection current={page.uiLanguage} onChange={model.setUiLanguage} />;
      case 'summaryProvider':
        // Question detection sits with the engine: its optional check runs on that engine. It is
        // one more row of the same block, so it keeps the row rhythm instead of the section gap.
        return (
          <div className="flex flex-col">
            <ProviderSection page={page} model={model} />
            <div className="mt-2 border-t border-hairline">
              <LiveQuestionsSection selectedProvider={page.provider} />
            </div>
            <div className="mt-2 border-t border-hairline">
              <CustomTemplateSection />
            </div>
          </div>
        );
      case 'microphone':
        // Type at cursor works only while a take records, so it follows what is recorded. It
        // is a block of its own in the tab's gap; `recording`, its natural slot, is not built.
        return (
          <>
            <MicrophoneSection />
            <CursorTypingSection />
          </>
        );
      case 'meetingLanguage':
        return (
          <MeetingLanguageSection
            transcription={page.transcriptionLanguage}
            summary={page.summaryLanguage}
            onChange={model.setMeetingLanguage}
          />
        );
      case 'transcription':
        return <TranscriptionSection page={page} model={model} />;
      case 'callDetection':
        return <CallDetectionSection />;
      case 'appearance':
        return <AppearanceSection />;
      case 'startup':
        return <StartupSection />;
      case 'data':
        return <DataSection />;
      case 'about':
        return <AboutSection />;
      default:
        return null;
    }
  };

  // Only the selected panel is mounted, so a hidden tab reads nothing and keeps no state.
  const tabs: readonly TabItem[] = SETTINGS_TABS.map((item) => ({
    value: item.id,
    label: t(item.labelKey),
    testId: `SettingsTab-${item.id}`,
    content: (
      // The scroll margin keeps a control that takes focus clear of the sticky tab list.
      <div className="flex flex-col gap-8 [&_*]:scroll-mt-12">
        {SETTINGS_SECTIONS.filter(
          (section) => section.tab === item.id && section.status === 'built',
        ).map((section) => (
          <Fragment key={section.id}>{renderBlock(section.id)}</Fragment>
        ))}
      </div>
    ),
  }));

  return (
    <section className="flex flex-col gap-8" aria-busy={model.loading}>
      <SectionHeader level={1} quiet title={t('SettingsPage_Title.Text')} />

      {model.problem ? (
        <Notice tone="warning" onDismiss={model.clearProblem} dismissLabel={t('Ui_Close')}>
          {model.problem}
        </Notice>
      ) : null}

      {page === null && model.loading ? (
        <SkeletonText lines={6} className="py-3" label={t('Ui_SettingsLoading')} />
      ) : null}

      {model.loadError !== null ? (
        <div className="flex flex-col items-start gap-3">
          <Notice tone="warning" className="self-stretch">
            {t('Ui_SettingsLoadFailed', model.loadError)}
          </Notice>
          <Button
            onClick={() => {
              void model.load();
            }}
          >
            {t('Ui_XaiRetry')}
          </Button>
        </div>
      ) : null}

      {page === null && appearanceBuilt ? <AppearanceSection /> : null}

      {page ? (
        <div
          className={`flex flex-col gap-8${revealed ? ' animate-fade-in' : ''}`}
          data-testid="settings-content"
        >
          {page.notices.map((notice) => (
            <Notice
              key={notice.id}
              tone="warning"
              onDismiss={() => {
                model.dismissNotice(notice.id);
              }}
              dismissLabel={t('Ui_Close')}
            >
              {t('Ui_SettingsRecovered', notice.keptAs)}
            </Notice>
          ))}
          <Tabs
            tabs={tabs}
            value={tab}
            onValueChange={(next) => {
              const chosen = SETTINGS_TABS.find((item) => item.id === next);
              if (chosen) setTab(chosen.id);
            }}
            label={t('Ui_SettingsTabsLabel')}
            listTestId="SettingsTabs"
            // The list stays in reach while a long tab scrolls under it.
            listClassName="sticky top-0 z-10 bg-paper"
          />
        </div>
      ) : null}
    </section>
  );
}
