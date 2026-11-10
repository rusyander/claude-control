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
    // Настоящий HTTP на loopback и временный каталог следа — среда node, без глобалов.
    environment: 'node',
    // Первым — отказ прогона посреди чужого mustfail в этой рабочей копии (tools/mutation-guard.mjs).
    globalSetup: ['../../tools/mutation-guard.mjs'],
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/**/*.test.ts', 'src/**/*.d.mts'],
      enabled: wholeSuite,
      reporter: ['text-summary', 'html'],
      // Пороги — замер своего набора при создании (09.11.2026); рост — повод поднять.
      thresholds: { statements: 90, branches: 81, functions: 98, lines: 96 },
    },
  },
});
