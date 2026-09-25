import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

/**
 * Прогон всего набора, а не его части. Покрытие и его пороги — про весь набор:
 * часть (файлы в аргументах, `-t`) порог не проходит по определению, а два
 * одновременных прогона с покрытием делят `coverage/.tmp` и валят друг друга
 * ENOENT («Something removed the coverage directory»). Поэтому часть набора
 * покрытие не считает; `--coverage.enabled` в командной строке сильнее.
 */
const wholeSuite = !process.argv
  .slice(2)
  .some(
    (arg) =>
      arg === '-t' ||
      arg.startsWith('--testNamePattern') ||
      (/^[^-]/.test(arg) && !['run', 'watch'].includes(arg)),
  );

/**
 * Конфиг тестов фронта.
 *
 * Собирается поверх `vite.config.ts`, а не заводится отдельно: оттуда
 * подхватываются алиасы (`@shared`, `@features`, …) и настройки SCSS. Тот же
 * приём использует `.storybook/main.ts` — иначе список алиасов пришлось бы
 * держать в трёх местах и однажды они разъедутся.
 */
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      // Пока покрыта чистая логика — разбор текста, сборка разметки, сторы.
      // Ей браузер не нужен, а без jsdom прогон остаётся быстрым.
      environment: 'node',
      include: ['src/**/*.test.{ts,tsx}'],
      coverage: {
        provider: 'v8',
        // Логика живёт в model/ и lib/. Разметка, витрина и типы к покрытию
        // отношения не имеют: их проверяют Storybook и функциональные прогоны.
        include: ['src/**/model/**', 'src/shared/lib/**', 'src/shared/api/**'],
        exclude: ['src/**/*.test.{ts,tsx}', 'src/**/*.types.ts', 'src/**/*.stories.tsx'],
        // Считается в каждом прогоне всего набора: порог — часть гейта, а не
        // отдельный режим. Уровень зафиксирован по замеру 06.09.2026 (52,9 / 56,9 /
        // 50,0 / 52,4): падение ниже делает `pnpm test` красным, рост — повод поднять порог.
        enabled: wholeSuite,
        reporter: ['text-summary', 'html'],
        thresholds: { statements: 52, branches: 56, functions: 49, lines: 52 },
      },
    },
  }),
);
