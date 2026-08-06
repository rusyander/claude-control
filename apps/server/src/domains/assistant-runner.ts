/**
 * Реальный запуск ассистента активного провайдера (Ф6b) — мультимодельная ветка
 * ЧЕРЕЗ switch по провайдеру. НЕЗЫБЛЕМОЕ ПРАВИЛО: ветка Claude не переписывается —
 * `runAssistant` для claude делегирует существующему CLI-пути (print-режим), а
 * богатый стриминговый чат Claude (ChatRunner/chat-routes) этот модуль НЕ трогает.
 *
 * Прочие провайдеры:
 *  - `cli` → one-shot CLI-раннер: spawn `provider.cli` с НЕинтерактивным флагом из
 *    метаданных `assistant.oneShotArgs` (argv-массив, промпт ОТДЕЛЬНЫМ элементом,
 *    БЕЗ интерполяции в shell; таймаут; stdout → ответ, stderr → ошибка). Basic-
 *    режим — простой текст, помечается `experimental`.
 *  - `api` → прямой вызов модельного API через нативный `fetch` (без новых
 *    зависимостей) по `apiKind`. Ключ берётся из `getRawKey` и НЕ логируется.
 *  - `none` → не вызываем, возвращаем структурную причину для модалки.
 *
 * ПРИОРИТЕТ — ПОДПИСКА: режим резолвится `resolveRunner` (cli → api → none).
 *
 * Файл — вход раннера: части лежат в `assistant-runner/` (`types.ts` — реплики,
 * внедряемые зависимости и переэкспорт контрактных типов; `constants.ts` —
 * таймаут, адреса API и зашитые модели; `cli.ts` — spawn, one-shot и сессионный
 * режим; `api.ts` — прямые вызовы модельных API; `run.ts` — сам switch).
 */
export type {
  AssistantEndpoint,
  AssistantMessage,
  AssistantRunReason,
  AssistantRunResult,
  RunAssistantDeps,
} from './assistant-runner/types.ts';
export { runAssistant } from './assistant-runner/run.ts';
