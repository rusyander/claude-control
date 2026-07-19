import { useEffect, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useSettings } from '@entities/AppConfig';

interface ThemeProviderProps {
  children: ReactNode;
}

/**
 * Применяет настройки оформления к документу. Тема и режимы доступности
 * выражены data-атрибутами на <html>, а не классами компонентов: так стили
 * переключаются мгновенно и без перерисовки дерева React.
 */
export function ThemeProvider({ children }: ThemeProviderProps) {
  const { data: settings } = useSettings();
  const { i18n } = useTranslation();

  const theme = settings?.theme ?? 'system';
  const language = settings?.language ?? 'ru';

  useEffect(() => {
    const root = document.documentElement;

    const applyTheme = (): void => {
      const resolved =
        theme === 'system'
          ? window.matchMedia('(prefers-color-scheme: dark)').matches
            ? 'dark'
            : 'light'
          : theme;
      root.dataset.theme = resolved;
    };

    applyTheme();

    // В системном режиме следим за сменой темы ОС, иначе интерфейс
    // останется светлым после того, как система переключилась в тёмную.
    if (theme !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', applyTheme);
    return () => media.removeEventListener('change', applyTheme);
  }, [theme]);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.largeText = String(settings?.largeText ?? false);
    root.dataset.reduceMotion = String(settings?.reduceMotion ?? false);
    root.dataset.highContrast = String(settings?.highContrast ?? false);
  }, [settings?.largeText, settings?.reduceMotion, settings?.highContrast]);

  useEffect(() => {
    if (i18n.language !== language) void i18n.changeLanguage(language);
    document.documentElement.lang = language;
  }, [language, i18n]);

  return children;
}
