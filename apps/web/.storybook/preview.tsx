import { useEffect } from 'react';
import type { Decorator, Preview } from '@storybook/react-vite';
import { I18nextProvider } from 'react-i18next';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { i18n } from '../src/shared/config/i18n';
import '../src/shared/styles/global.scss';

/**
 * Окружение витрины повторяет приложение: те же токены из global.scss, тот же
 * словарь и тот же клиент запросов. Компонент, который в приложении берёт
 * перевод или данные, в витрине не должен падать.
 */

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

/** Тема и доступность живут на <html> — витрина переключает их так же. */
const withTheme: Decorator = (Story, context) => {
  const { theme, largeText, reduceMotion, highContrast } = context.globals;

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.dataset.largeText = String(largeText === 'on');
    root.dataset.reduceMotion = String(reduceMotion === 'on');
    root.dataset.highContrast = String(highContrast === 'on');
    document.body.style.background = 'var(--color-bg)';
    document.body.style.color = 'var(--color-fg)';
  }, [theme, largeText, reduceMotion, highContrast]);

  return <Story />;
};

const withProviders: Decorator = (Story) => (
  <QueryClientProvider client={queryClient}>
    <I18nextProvider i18n={i18n}>
      <div style={{ padding: 'var(--spacing-lg)' }}>
        <Story />
      </div>
    </I18nextProvider>
  </QueryClientProvider>
);

const withLanguage: Decorator = (Story, context) => {
  useEffect(() => {
    void i18n.changeLanguage(context.globals.locale);
  }, [context.globals.locale]);

  return <Story />;
};

const preview: Preview = {
  // Страница документации у каждого компонента: описание, таблица свойств
  // из типов и все истории подряд. Отдельно её заводить не нужно.
  tags: ['autodocs'],
  decorators: [withProviders, withLanguage, withTheme],
  parameters: {
    controls: { expanded: true, matchers: { color: /(background|color)$/i } },
    options: {
      storySort: {
        order: ['Основы', ['Введение', 'Токены', 'Иконки'], 'Компоненты', 'Формы', 'Данные'],
      },
    },
    docs: { toc: true },
    // Фон витрины берётся из токена темы: собственная палитра Storybook
    // показывала бы компоненты не в той среде, в которой они живут.
    backgrounds: { disable: true },
  },
  globalTypes: {
    theme: {
      description: 'Тема оформления',
      defaultValue: 'dark',
      toolbar: {
        title: 'Тема',
        icon: 'circlehollow',
        items: [
          { value: 'light', title: 'Светлая' },
          { value: 'dark', title: 'Тёмная' },
        ],
        dynamicTitle: true,
      },
    },
    locale: {
      description: 'Язык интерфейса',
      defaultValue: 'ru',
      toolbar: {
        title: 'Язык',
        icon: 'globe',
        items: [
          { value: 'ru', title: 'Русский' },
          { value: 'en', title: 'English' },
        ],
        dynamicTitle: true,
      },
    },
    largeText: {
      description: 'Крупный текст',
      defaultValue: 'off',
      toolbar: {
        title: 'Крупный текст',
        icon: 'zoom',
        items: [
          { value: 'off', title: 'Обычный' },
          { value: 'on', title: 'Крупный' },
        ],
      },
    },
    reduceMotion: {
      description: 'Меньше движения',
      defaultValue: 'off',
      toolbar: {
        title: 'Движение',
        icon: 'play',
        items: [
          { value: 'off', title: 'Анимации включены' },
          { value: 'on', title: 'Меньше движения' },
        ],
      },
    },
    highContrast: {
      description: 'Высокий контраст',
      defaultValue: 'off',
      toolbar: {
        title: 'Контраст',
        icon: 'contrast',
        items: [
          { value: 'off', title: 'Обычный' },
          { value: 'on', title: 'Высокий' },
        ],
      },
    },
  },
};

export default preview;
