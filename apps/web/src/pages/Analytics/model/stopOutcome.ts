import type { SessionStopResult } from '@agentdeck/contracts';

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
