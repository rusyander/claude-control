// Эталонный ESLint flat config фронт-доктрины (ESLint 9+).
// Подставлять в проект по согласию, адаптировать под его версии/плагины.
// Установка плагинов:
//   npm i -D eslint typescript-eslint eslint-plugin-boundaries eslint-plugin-import \
//            eslint-plugin-check-file eslint-plugin-react eslint-plugin-react-hooks
// Границы FSD/нейминг/barrel — машинный энфорсмент правил structure.md.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import boundaries from 'eslint-plugin-boundaries';
import importPlugin from 'eslint-plugin-import';
import checkFile from 'eslint-plugin-check-file';
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
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: {
      boundaries,
      import: importPlugin,
      'check-file': checkFile,
      'react-hooks': reactHooks,
    },
    settings: {
      // Слои FSD → типы элементов boundaries
      'boundaries/elements': [
        { type: 'app', pattern: 'src/app/*' },
        { type: 'pages', pattern: 'src/pages/*' },
        { type: 'features', pattern: 'src/features/*', capture: ['feature'] },
        { type: 'entities', pattern: 'src/entities/*', capture: ['entity'] },
        { type: 'shared', pattern: 'src/shared/*' },
      ],
      'import/resolver': { typescript: true },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,

      // --- Границы слоёв (только вниз; cross-feature запрещён) ---
      'boundaries/element-types': [
        'error',
        {
          default: 'disallow',
          rules: [
            { from: 'app', allow: ['pages', 'features', 'entities', 'shared'] },
            { from: 'pages', allow: ['features', 'entities', 'shared'] },
            {
              from: 'features',
              allow: ['entities', 'shared', ['features', { feature: '${feature}' }]],
            },
            { from: 'entities', allow: ['shared', ['entities', { entity: '${entity}' }]] },
            { from: 'shared', allow: ['shared'] },
          ],
        },
      ],
      'boundaries/no-private': ['error', { allowUninitialized: true }],

      // --- Импорт только через barrel, без циклов ---
      'import/no-internal-modules': [
        'error',
        {
          allow: ['**/index.ts', '@/shared/**', '**/*.module.scss', '**/*.{png,svg,json}'],
        },
      ],
      'import/no-cycle': ['error', { maxDepth: 1 }],
      'import/no-namespace': 'warn', // чистые именованные импорты (ADR-007): без `import * as ns`
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ExportDefaultDeclaration',
          message: 'Named-экспорты (ADR-003): default запрещён (кроме требуемых фреймворком мест).',
        },
      ],

      // --- Нейминг: проект PascalCase, shared kebab-case ---
      'check-file/filename-naming-convention': [
        'error',
        {
          'src/{entities,features,pages,app}/**/*.{tsx,ts}': 'PASCAL_CASE',
          'src/shared/**/*.{tsx,ts}': 'KEBAB_CASE',
        },
        { ignoreMiddleExtensions: true },
      ],
      'check-file/folder-naming-convention': [
        'error',
        {
          'src/{entities,features,pages}/**/': 'PASCAL_CASE',
          'src/shared/**/': 'KEBAB_CASE',
        },
      ],

      // --- Качество (пороги как сигналы) ---
      'max-lines': ['warn', { max: 400, skipBlankLines: true, skipComments: true }],
      'no-nested-ternary': 'error',
      'no-lonely-if': 'warn',
    },
  },
  // Исключения из max-lines
  {
    files: ['**/*.test.{ts,tsx}', '**/*.constants.ts', '**/*.mock.{ts,tsx}', '**/*.stories.tsx'],
    rules: { 'max-lines': 'off', 'no-restricted-syntax': 'off' },
  },
);
