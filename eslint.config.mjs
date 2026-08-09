// ESLint flat config монорепы (ESLint 9+).
// Границы слоёв FSD и пороги качества фронта проверяются машинно; барьер публичного API слайса —
// в `.dependency-cruiser.cjs`, потому что там он выражается точнее.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  // Сборки, зависимости и рабочий мусор проверок — не исходный код.
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/storybook-static/**',
      '.qa-screenshots/**',
      '.agent/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  /**
   * Подчёркивание = «параметр объявлен намеренно и не используется». Так уже
   * ведёт себя `tsc` (`noUnusedParameters`), и без этой строки два проверяющих
   * расходились: TypeScript молчал, ESLint падал. Нужно там, где форма функции
   * задана извне — общий тип регистрации маршрутов, обработчик Fastify, колбэк
   * библиотеки: параметр обязан быть в списке, а делать с ним нечего.
   */
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  // Служебные скрипты исполняются Node напрямую: process и console там есть.
  {
    files: ['tools/**/*.{mjs,js}', '*.cjs', '*.mjs'],
    languageOptions: { globals: { ...globals.node } },
  },
  // Код внутри page.evaluate() выполняется браузером, а не Node.
  {
    files: ['tools/qa/**/*.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  /**
   * Конфигурация Metro — единственный CommonJS в приложении на телефоне: её
   * читает сам сборщик до всякой транспиляции, поэтому ни `import`, ни ESM-путь
   * там невозможны.
   */
  {
    files: ['apps/mobile/*.js'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  /**
   * Приложение на React Native. Правила хуков те же, что у фронта: расхождение
   * означало бы, что одна и та же ошибка ловится в браузере и проходит на
   * телефоне. Экспорт по умолчанию здесь не запрещён — его требует expo-router:
   * файл маршрута ОБЯЗАН отдавать компонент именно так.
   */
  {
    files: ['apps/mobile/{app,src}/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  /**
   * Правила хуков для фронта. Блок доктрины ниже нацелен на `src/**`, а код
   * этого монорепо лежит в `apps/web/src/**` — из-за чего плагин не был
   * подключён вовсе, и даже `eslint-disable react-hooks/...` считался ошибкой
   * «правило не найдено». Здесь только классические правила: `rules-of-hooks`
   * нарушений не находит, `exhaustive-deps` включён предупреждением, чтобы
   * существующие замечания не блокировали работу.
   */
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  /**
   * Блок доктрины фронта. Код лежит в `apps/web/src/**`, поэтому паттерн указывает туда:
   * объявленный на `src/**` блок не совпадал ни с одним файлом и не работал вовсе.
   *
   * Границы слоёв, барьер публичного API и циклы проверяет dependency-cruiser
   * (`.dependency-cruiser.cjs`), а не ESLint: у него есть рабочий резолвер алиасов из
   * `tsconfig.depcruise.json`, и он отличает импорт в чужой слайс от соседнего файла своей папки.
   * Здесь остаётся то, для чего резолвер не нужен.
   *
   * Нейминг файлов намеренно не проверяется: в проекте принят camelCase для не-компонентных
   * модулей, и это его идиом, а не отступление.
   * Правила хуков — в отдельном блоке выше, чтобы `exhaustive-deps` остался предупреждением.
   */
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    plugins: {
      import: importPlugin,
    },
    rules: {
      'import/no-namespace': 'warn', // чистые именованные импорты: без `import * as ns`
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ExportDefaultDeclaration',
          message: 'Named-экспорты (ADR-003): default запрещён (кроме требуемых фреймворком мест).',
        },
      ],

      // --- Качество (пороги как сигналы) ---
      'max-lines': ['warn', { max: 400, skipBlankLines: true, skipComments: true }],
      'no-nested-ternary': 'error',
      'no-lonely-if': 'warn',
    },
  },
  // Исключения из max-lines: тесты, данные и наборы историй — не логика, порог строк к ним не применим.
  // Словари i18n и тексты справки — тоже данные: их размер задан объёмом интерфейса, а не сложностью.
  {
    files: [
      '**/*.test.{ts,tsx}',
      '**/*.constants.ts',
      '**/*.mock.{ts,tsx}',
      '**/*.stories.tsx',
      'apps/web/src/shared/config/i18n/**/*.ts',
      'apps/web/src/entities/Command/model/builtinCommands.ts',
    ],
    rules: { 'max-lines': 'off', 'no-restricted-syntax': 'off' },
  },
);
