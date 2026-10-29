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
      // Клиенты-разборщики — оракул тестов, не код пакета; объявления типов v8 не разберёт.
      exclude: ['src/**/*.test.ts', 'src/**/*.cases.ts', 'src/**/*.d.mts', 'src/clients/**'],
      enabled: wholeSuite,
      reporter: ['text-summary', 'html'],
      thresholds: { statements: 97, branches: 86, functions: 99, lines: 98 },
    },
  },
});
