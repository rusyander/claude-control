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
    // Чистая логика над строками и временными каталогами — среда node, без глобалов.
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
      // Замер 30.10 (переезд механики сит): 98.9 / 96.2 / 97.2 / 98.7 — порог чуть ниже.
      thresholds: { statements: 98, branches: 95, functions: 97, lines: 98 },
    },
  },
});
