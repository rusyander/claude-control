/**
 * Стаб-контур для свипов панели: тонкая обёртка над сценарием `contour` общей заглушки
 * (`packages/stub-model/src/scenarios/contour.mjs`, P120). Форма провода контура — вендорные
 * кадры, отказы, каталог, агенты — живёт ТАМ, одна на свипы панели и тесты ядра; своего кода
 * SSE здесь нет.
 *
 * Сценарий выбирается ИМЕНЕМ МОДЕЛИ (`stub-guardrails`, `stub-451`, …), умолчание — `--scenario`.
 *
 * Запуск: `node tools/qa/stub-platform.mjs [--port 5199] [--scenario clean] [--delay 0]`
 * В коде: `const stub = await startStubPlatform({ port: 0 }); stub.url; stub.calls; await stub.close();`
 */
import { pathToFileURL } from 'node:url';
import {
  DECK_JSON,
  MODELS,
  REWRITTEN_FINAL,
  SCENARIOS,
  startContourStub,
} from '../../packages/stub-model/src/scenarios/contour.mjs';

export { DECK_JSON, REWRITTEN_FINAL };

/** Прежнее имя для свипов и кадров справки: `{ url, port, calls, close }`. */
export const startStubPlatform = (options = {}) => startContourStub(options);

/**
 * Запуск из терминала: держит порт, пока его не остановят. Сравнение через `pathToFileURL`:
 * на Windows склейка строки давала `file://C:/…` против `file:///C:/…`, и ветка не срабатывала.
 */
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const arg = (name, fallback) => {
    const at = process.argv.indexOf(`--${name}`);
    return at === -1 ? fallback : process.argv[at + 1];
  };
  const scenario = arg('scenario', 'clean');
  if (!SCENARIOS.has(scenario)) {
    console.error(`неизвестный сценарий «${scenario}»; есть: ${[...SCENARIOS].join(', ')}`);
    process.exit(1);
  }
  const stub = await startStubPlatform({
    port: Number(arg('port', 5199)),
    scenario,
    delayMs: Number(arg('delay', 0)),
  });
  console.log(`стаб-контур: ${stub.url} (сценарий по умолчанию: ${scenario})`);
  console.log(`модели: ${MODELS.map((model) => model.id).join(', ')}`);
  console.log('сценарий выбирается именем модели: stub-guardrails, stub-451, stub-image, …');
}
