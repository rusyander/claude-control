import { fileURLToPath } from 'node:url';

import { configDefaults, defineConfig } from 'vitest/config';

import { coverageRunDir, pruneFinishedRuns } from './vitest.coverage-dir.ts';
import { isWholeSuite } from './vitest.whole-suite.ts';

const coverageRoot = fileURLToPath(new URL('./coverage', import.meta.url));

/**
 * `*.alone.test.ts` — проверки, чьи процессы видны любому соседнему поиску по `/proc` (закрытый
 * свой процесс делает чужую остановку «не доказанной»): общий параллельный прогон их не берёт,
 * их гонит отдельный проход `AGENTDECK_CORE_ALONE=1` — по одному файлу, без покрытия
 * (`tools/core-linux.mjs` после основного). Сейчас там только Linux-проверки.
 */
const alone = process.env.AGENTDECK_CORE_ALONE === '1';
const ALONE_FILES = 'src/**/*.alone.test.ts';

/** Покрытие считает только прогон всего набора — та же причина, что у сервера (общий `coverage/.tmp`). */
const wholeSuite = !alone && isWholeSuite(process.argv.slice(2));
// Свой каталог на прогон (vitest.coverage-dir.ts): общий `coverage/.tmp` параллельных прогонов
// стирался чужим стартом. `--coverage.reportsDirectory=…` из командной строки по-прежнему главнее.
if (wholeSuite) pruneFinishedRuns(coverageRoot);

export default defineConfig({
  test: {
    environment: 'node',
    include: alone ? [ALONE_FILES] : ['src/**/*.test.ts', 'vitest.*.test.ts'],
    exclude: alone ? configDefaults.exclude : [...configDefaults.exclude, ALONE_FILES],
    fileParallelism: !alone,
    // Первым — отказ прогона посреди чужой живой мутации mustfail (её красное ничего не доказывает).
    globalSetup: ['../../tools/mutation-guard.mjs', './vitest.temp-sandbox.ts'],
    // Тесты ядра поднимают настоящие процессы, git и журналы на диске; на Windows под общей
    // нагрузкой `pnpm test` пять секунд по умолчанию мало (тот же замер, что у сервера).
    testTimeout: 20_000,
    hookTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/**/*.test.ts', 'src/**/*.types.ts', 'src/**/__fixtures__/**'],
      enabled: wholeSuite,
      reportsDirectory: coverageRunDir(coverageRoot),
      // `json` — карта для слияния Windows + Linux (`tools/core-coverage-merge.mjs`).
      reporter: ['text-summary', 'html', 'json'],
      // Красный прогон тоже отдаёт карту: слитый порог печатает цифры и падает по красному прогону.
      reportOnFailure: true,
      // Порога здесь НЕТ намеренно: часть кода исполняется только на одной ОС (exec-бит,
      // группы процессов, таблицы процессов Windows), и порог одной ОС краснел бы на чужих
      // ветках. Связывает СЛИТЫЙ порог `pnpm core:test:all` — `coverage-thresholds.json`
      // (85/80/85/85); он растёт с замером, вниз молча не опускается. `pnpm core:test`
      // отдельно лишь печатает цифры своей ОС.
    },
  },
});
