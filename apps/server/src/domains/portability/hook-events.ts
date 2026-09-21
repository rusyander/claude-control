import type { EnvBlocking } from '@agentdeck/contracts/portable-env';
import type { ConfigProvider } from '../../providers/types.ts';
import { canonBlockingOfEvent } from './needs.ts';

/**
 * СОБЫТИЯ ХУКОВ ОДНОГО CLI — единственный источник и для импорта, и для матрицы.
 *
 * Ревью волны П1 нашло здесь две головы одного дракона: канон объявлял `Stop`
 * блокирующим, справочник самого Claude — наблюдательным, и П1 оказалась первым
 * кодом, поставившим эти два словаря по разные стороны одного сравнения. Итог был
 * не косметический: хук, перенесённый в ТОТ ЖЕ CLI, из которого снят, получал
 * приговор «блокировка потеряна» — перенос в самого себя обязан быть нативным по
 * построению.
 *
 * Поэтому факт теперь один и берётся у провайдера:
 *
 *  - универсальный адаптер → `hooksConfig.events` (имена ведёт сам адаптер
 *    формата) и `hooksConfig.blockingEvents` (способность остановить действие —
 *    по документации CLI);
 *  - собственная модель (у Claude) → `nativeMechanisms.hookEvents`.
 *
 * Списка провайдеров здесь нет и быть не может: одиннадцатый CLI описывается
 * каталогом и получает и импорт, и столбец матрицы, не меняя ни строки домена.
 */

export interface ProviderHookEvent {
  readonly name: string;
  readonly blocking: boolean;
}

/**
 * Что умеет механизм хуков этого CLI. Раздел «только для чтения»
 * (`writeDisabledReason`) СЧИТАЕТСЯ существующим: запрет касается записи панелью,
 * а не того, какие события у CLI есть. Разделять эти два вопроса обязан
 * вызывающий — матрица делает это отдельным фактом профиля.
 */
export function providerHookEvents(provider: ConfigProvider): readonly ProviderHookEvent[] {
  const hooks = provider.hooksConfig;
  if (hooks) {
    const blocking = new Set(hooks.blockingEvents);
    return hooks.events.map((name) => ({ name, blocking: blocking.has(name) }));
  }
  return (provider.nativeMechanisms?.hookEvents ?? []).map((event) => ({
    name: event.name,
    blocking: event.blocking,
  }));
}

/**
 * Останавливает ли это событие действие У ЭТОГО CLI.
 *
 * Объявленное событие отвечает само за себя; о необъявленном спрашивается канон
 * (`canonBlockingOfEvent`) — так приезжают события, которые импортёр СВЁЛ к
 * канону из чужих имён (`file_edited` OpenCode → `PostToolUse`), и незнакомые
 * записи, которые fail-closed считаются блокирующими.
 */
export function blockingOfEvent(provider: ConfigProvider, event: string): EnvBlocking {
  const declared = providerHookEvents(provider).find((candidate) => candidate.name === event);
  if (declared) return declared.blocking ? 'blocks' : 'observes';
  return canonBlockingOfEvent(event);
}
