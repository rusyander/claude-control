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
      // Замер 30.10 своего набора: 68.9 / 55 / 74 / 70.8. Остальное заглушки гоняют тесты ядра
      // (adapters/forge, forge-wiring) — их покрытие здесь не считается; порог только растёт.
      thresholds: { statements: 68, branches: 54, functions: 73, lines: 70 },
    },
  },
});
