import type { CoreProxyCode, CoreSupervisorStatus } from '@agentdeck/contracts/core/supervisor';

/**
 * Какую карточку рисовать по отказу прокладки и состоянию надзора (этап 10). Надзор главнее
 * отказа: прокладка ответила `core-absent` за миг до подъёма, а надзор уже видит `starting`.
 *
 * - `fault` — надзор сдался (5 падений за 10 минут): выход, хвост журнала, «Перезапустить»;
 * - `starting` — ядро поднимается или ждёт следующей попытки; страница ждёт опросом;
 * - `absent` — надзора нет (выключен), ядра нет;
 * - `unverified` / `unreachable` — ядро есть, но себя не подтвердило или молчит.
 *
 * `status === undefined` — состояние надзора ещё не прочитано: решает отказ.
 */
export type CoreFaultView = 'fault' | 'starting' | 'absent' | 'unverified' | 'unreachable';

export function coreFaultView(
  refusal: CoreProxyCode,
  status: CoreSupervisorStatus | null | undefined,
): CoreFaultView {
  if (status?.state === 'fault' || refusal === 'core-fault') return 'fault';
  if (refusal === 'core-unverified') return 'unverified';
  if (refusal === 'core-unreachable') return 'unreachable';
  // Надзор есть — ядро поднимает он; `up` при отказе — отказ пришёл до подъёма, сейчас перечитаем.
  if (status) return 'starting';
  if (refusal === 'core-starting') return 'starting';
  return 'absent';
}

/** Код отказа, чьи тексты рисует карточка вида. */
export const CODE_OF_VIEW: Record<CoreFaultView, CoreProxyCode> = {
  fault: 'core-fault',
  starting: 'core-starting',
  absent: 'core-absent',
  unverified: 'core-unverified',
  unreachable: 'core-unreachable',
};

/** Секунд до следующей попытки (не меньше нуля); попытки не назначено — `null`. */
export function secondsUntil(at: string | null, now: number): number | null {
  if (!at) return null;
  const ms = Date.parse(at) - now;
  return Number.isFinite(ms) ? Math.max(0, Math.ceil(ms / 1_000)) : null;
}
