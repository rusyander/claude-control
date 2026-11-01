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
    // Чистая арифметика над таблицей тарифов — среда node, без глобалов.
    environment: 'node',
    // Отказ прогона посреди чужого mustfail в этой рабочей копии.
    globalSetup: ['../../tools/mutation-guard.mjs'],
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/**/*.test.ts'],
      enabled: wholeSuite,
      reporter: ['text-summary', 'html'],
      // Замер 30.10.2026 при переезде из сервера (98,5 / 94,3 / 100 / 100): ниже — красный
      // `pnpm test`, рост — повод поднять порог.
      thresholds: { statements: 98, branches: 94, functions: 100, lines: 100 },
    },
  },
});
