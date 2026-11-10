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
    // Чистые функции над портом отправки, без сети и диска — среда node, без глобалов.
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
      // Пороги — замер при создании пакета (09.11.2026): ниже — красный `pnpm test`,
      // рост — повод поднять порог.
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
});
