import type { SessionLocation, SessionStopResult, SessionWhere } from '@agentdeck/contracts';

/**
 * Решения кнопок «Перейти» и «Остановить» у строки «Сессий» — отдельно от
 * разметки, чтобы каждое было проверено тестом, а не глазами.
 */

/** «Перейти»: чат панели и завершённая сессия — в разговор; процесс вне панели — окно «где идёт». */
export type GoPlan = { kind: 'chat'; id: string } | { kind: 'where' };

export function goPlan(location: SessionLocation): GoPlan {
  const { where } = location;
  if (where.kind === 'panel') return { kind: 'chat', id: where.chatId };
  // Завершённая сессия продолжается из её разговора; идущая вне панели — нет:
  // второй писатель в тот же транскрипт перемешал бы ходы двух процессов.
  if (where.kind === 'finished') return { kind: 'chat', id: location.sessionId };
  return { kind: 'where' };
}

/** «Остановить»: что именно будет снято — или почему снимать нечего. */
export type StopPlan =
  | { kind: 'panel'; chatId: string }
  | { kind: 'process'; pid: number; startedAt: string; ownsPanel: boolean }
  | { kind: 'nothing'; reason: 'unidentified' | 'finished' };

export function stopPlan(where: SessionWhere): StopPlan {
  if (where.kind === 'panel') return { kind: 'panel', chatId: where.chatId };
  if (where.kind === 'process') {
    return {
      kind: 'process',
      pid: where.pid,
      startedAt: where.startedAt,
      ownsPanel: where.ownsPanel,
    };
  }
  return { kind: 'nothing', reason: where.kind };
}

/** Итог стопа процесса словами: ключ перевода, параметры и тон уведомления. */
export interface StopOutcome {
  key: string;
  params: Record<string, number>;
  tone: 'success' | 'info' | 'warning';
}

/** `owns-panel` сюда не попадает: это вопрос к человеку, а не итог. */
export function stopOutcome(result: SessionStopResult): StopOutcome {
  const { pid } = result;
  switch (result.result) {
    case 'stopped':
      return {
        key: 'analytics.sessionStopped',
        params: { count: result.killed ?? 1 },
        tone: 'success',
      };
    case 'gone':
      return { key: 'analytics.sessionGone', params: { pid }, tone: 'info' };
    case 'reused':
      return { key: 'analytics.sessionReused', params: { pid }, tone: 'warning' };
    // Процесс жив и не тронут: номер нечем сверить (F-145) — не «уже нет».
    case 'unverified':
      return { key: 'analytics.sessionUnverified', params: { pid }, tone: 'warning' };
    default:
      return { key: 'analytics.sessionStillRunning', params: { pid }, tone: 'warning' };
  }
}

// Сравнение путей — одно на весь фронт, живёт в shared.
export { samePath } from '@shared/lib/file-path';
