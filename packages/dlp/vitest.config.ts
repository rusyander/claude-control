import { defineConfig } from 'vitest/config';

/** Покрытие считает только прогон всего набора — та же причина, что у сервера (общий `coverage/.tmp`). */
const wholeSuite = !process.argv
  .slice(2)
  .some(
    (arg) =>
      arg === '-t' ||
      arg.startsWith('--testNamePattern') ||
      (/^[^-]/.test(arg) && !['run', 'watch'].includes(arg)),
  );

export default defineConfig({
  test: {
    // Чистая логика над строками и одним временным каталогом — среда node, без глобалов.
    environment: 'node',
    // Отказ прогона посреди чужого mustfail в этой рабочей копии.
    globalSetup: ['../../tools/mutation-guard.mjs'],
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // Объявления типов к `.mjs` — не код: v8 разбирает их как JS и шумит PARSE_ERROR.
      exclude: ['src/**/*.test.ts', 'src/**/*.d.mts'],
      enabled: wholeSuite,
      reporter: ['text-summary', 'html'],
      // Замер 28.10.2026 при переезде из сервера (86,4 / 76,0 / 91,8 / 91,3): ниже — красный
      // `pnpm test`, рост — повод поднять порог.
      thresholds: { statements: 86, branches: 75, functions: 91, lines: 91 },
    },
  },
});
