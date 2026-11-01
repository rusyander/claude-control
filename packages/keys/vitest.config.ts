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
    // Шифрование и один временный каталог — среда node, без глобалов.
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
      // Порог — по замеру при переезде из сервера (30.10.2026); ниже — красный `pnpm test`.
      thresholds: { statements: 90, branches: 80, functions: 90, lines: 90 },
    },
  },
});
