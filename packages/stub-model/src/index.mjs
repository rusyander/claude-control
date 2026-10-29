/**
 * `@agentdeck/stub-model` — ОДНА заглушка модели ядра (R:PR-09, P120): три протокола
 * провода, поток SSE как его разбирают настоящие CLI, сценарий шагов (текст, вызов
 * инструмента, шаг-функция над прошлыми телами, ошибки 402/429/451/503, окно,
 * задержки, правила по метке), след каждого запроса без значений доступа.
 *
 * Простой ESM без зависимостей и без сборки: его грузят и vitest ядра (типы —
 * `index.d.mts`), и голый `node tools/qa/*.mjs` по относительному пути.
 */
import { DIALECT_IDS } from './dialects/index.mjs';

export { DIALECT_IDS } from './dialects/index.mjs';
export { RESERVED_PORTS, startStubModel } from './server.mjs';
export { PRESENT, redactHeaders } from './trace.mjs';

/**
 * Что заглушка умеет — для `routes/stub` (caps маршрута) и для теста покрытия
 * возможностей: каждая заявленная здесь возможность обязана иметь проверку на
 * каждом протоколе (P121), иначе тест пакета красный.
 */
export const STUB_CAPS = Object.freeze({
  dialects: DIALECT_IDS,
  streaming: true,
  nonStreaming: true,
  tools: true,
  /** Свободный инструмент (apply_patch у Codex) — только в responses. */
  customTools: Object.freeze(['openai-responses']),
  errors: Object.freeze([402, 429, 451, 503]),
  midStreamErrors: true,
  window: true,
  hold: true,
  stall: true,
  /** Текст шага массивом — несколько дельт одного блока; клиент склеивает их сам. */
  chunkedText: true,
  /** `usage.cached` — в поле кеша протокола (cache_read / cached_tokens). */
  cachedUsage: true,
  /** `extra` — поля сверх протокола в итоговом объекте ответа (`timings` llama-server). */
  extraFields: true,
  /** `release()` — досрочный конец удержаний: ответ уходит сразу. */
  release: true,
  /** Клиент оборвал запрос во время удержания — `requests[].aborted`. */
  aborted: true,
  /** `route` — свои пути вызывающего до путей пакета и наблюдение за каждым запросом. */
  routes: true,
  images: false,
  offline: true,
});
