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
      // Фикстуры — данные, не код: без исключения v8 пытается разобрать .jsonl и шумит PARSE_ERROR.
      exclude: ['src/**/*.test.ts', 'src/**/*.types.ts', 'src/**/__fixtures__/**'],
      // Считается в каждом прогоне: порог — часть гейта, а не отдельный режим.
      // Уровень зафиксирован по замеру 06.09.2026 (86,3 / 78,1 / 88,6 / 89,1):
      // падение ниже делает `pnpm test` красным, рост — повод поднять порог.
      enabled: true,
      reporter: ['text-summary', 'html'],
      thresholds: { statements: 85, branches: 77, functions: 88, lines: 88 },
    },
  },
});
