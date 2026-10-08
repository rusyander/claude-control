import type { PlatformAgentAnswer } from '@agentdeck/contracts';

/**
 * Предупреждать ли, что ход не попал в сессию.
 *
 * Только когда контур сказал это прямо: ответ настоящий, а сессия не
 * пополнилась. Без признака (хода без сессии или старого ответа) молчим —
 * додумывать за чужое хранилище панель не станет.
 */
export function warnsSessionGap(answer: PlatformAgentAnswer | undefined): boolean {
  return answer?.outcome === 'ok' && answer.sessionRecorded === false;
}
