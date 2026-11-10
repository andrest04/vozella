import type { ReactNode } from 'react';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Locale } from '../i18n/translate';
import { TooltipProvider } from '../ui';

/** The providers a renderer test needs around a component: strings and tooltips. */
export function Providers({ children, locale = 'en' }: { children: ReactNode; locale?: Locale }) {
  return (
    <I18nProvider initialLocale={locale}>
      <TooltipProvider delay={0}>{children}</TooltipProvider>
    </I18nProvider>
  );
}
