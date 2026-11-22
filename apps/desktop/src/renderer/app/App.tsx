import { RouterProvider } from '@tanstack/react-router';
import { useEffect } from 'react';
import { connectEngineSetupRequests } from '../features/settings/engine-focus';
import { I18nProvider, useT } from '../i18n/I18nProvider';
import type { Locale } from '../i18n/translate';
import { ToastProvider, TooltipProvider } from '../ui';
import { DialogHost } from './dialog-service';
import { router } from './router';
import { ThemeProvider } from './theme';

function Providers() {
  const t = useT();
  // Only this window has Settings: the setup link of a live answer (Record page or pill) lands here.
  useEffect(() => connectEngineSetupRequests(), []);
  return (
    <TooltipProvider delay={400}>
      <ToastProvider dismissLabel={t('MeetingPrompt_Dismiss.Text')}>
        <DialogHost>
          <RouterProvider router={router} />
        </DialogHost>
      </ToastProvider>
    </TooltipProvider>
  );
}

export function App({ initialLocale }: { initialLocale?: Locale }) {
  return (
    <ThemeProvider>
      <I18nProvider {...(initialLocale ? { initialLocale } : {})}>
        <Providers />
      </I18nProvider>
    </ThemeProvider>
  );
}
