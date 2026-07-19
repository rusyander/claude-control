import type { StorybookConfig } from '@storybook/react-vite';

/**
 * Storybook для UI-кита приложения.
 *
 * Алиасы (@shared и прочие), sass и плагин React берутся из vite.config.ts —
 * отдельной сборки нет, поэтому компоненты в витрине собираются ровно так же,
 * как в приложении, и расхождений между ними не возникает.
 */
const config: StorybookConfig = {
  stories: ['../src/**/*.mdx', '../src/**/*.stories.@(ts|tsx)'],
  addons: ['@storybook/addon-docs', '@storybook/addon-a11y'],
  framework: { name: '@storybook/react-vite', options: {} },
  typescript: {
    // Описания пропсов и значения по умолчанию Storybook берёт из типов —
    // так таблица свойств не расходится с кодом.
    reactDocgen: 'react-docgen-typescript',
    reactDocgenTypescriptOptions: {
      shouldExtractLiteralValuesFromEnum: true,
      shouldRemoveUndefinedFromOptional: true,
      propFilter: (prop) => !prop.parent || !/node_modules/.test(prop.parent.fileName),
    },
  },
};

export default config;
