import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Тесты домена — чистая логика над временными каталогами, без сети,
    // поэтому среда node и без глобалов.
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // Считаем покрытие по доменам и утилитам — там живёт логика. Точки входа
      // (index, routes) — это склейка, её проверяют функциональные прогоны.
      include: ['src/domains/**', 'src/lib/**', 'src/shared/**'],
      exclude: ['src/**/*.test.ts', 'src/**/*.types.ts'],
      reporter: ['text', 'html'],
    },
  },
});
