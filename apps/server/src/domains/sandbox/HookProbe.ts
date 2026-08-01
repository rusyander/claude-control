/**
 * Прямой прогон хука или скрипта на заготовленном событии.
 *
 * Хук — обычная программа: получает событие JSON на вход, пишет ответ в вывод,
 * а кодом 2 останавливает действие. Значит его можно проверить без модели —
 * мгновенно и бесплатно, подсунув событие руками. Это единственный вид
 * проверки в песочнице, который ничего не стоит и не расходует лимит.
 *
 * Модуль — вход в стенд хуков; шаги разложены по соседям: заготовки и разбор
 * своего события `HookEvents.ts`, запуск процесса и сборка команды
 * `HookRunner.ts`, чтение вердикта из вывода `HookDecision.ts`.
 */

export type { EventFixture, HookDecision, ProbeResult } from './HookProbe.types.ts';
export { CUSTOM_FIXTURE_ID } from './HookProbe.constants.ts';
export { EVENT_FIXTURES, isEventObject, parseCustomEvent } from './HookEvents.ts';
export { readDecision, tryParse } from './HookDecision.ts';
export { runCustomHookProbe, runHookProbe, scriptCommand } from './HookRunner.ts';
