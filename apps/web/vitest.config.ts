import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

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
        reporter: ['text', 'html'],
      },
    },
  }),
);
