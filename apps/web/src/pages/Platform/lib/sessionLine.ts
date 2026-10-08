import type { PlatformAgentSession } from '@agentdeck/contracts';

/**
 * Что писать про переписку сессии.
 *
 * Утверждение «контур ничего не помнит» вправе появиться ТОЛЬКО после удачного
 * чтения: это факт про чужое хранилище, а не про наше незнание. Пока запрос
 * идёт — молчим, отказ чтения называем отказом, и число берём то, которое
 * прислал контур (`total`), а не длину показываемого списка: инструментные ходы
 * агента панель не рисует, но они в сессии есть.
 */
export type SessionLine = 'kept' | 'empty' | 'failed' | 'unknown';

export function sessionLine(state: {
  isSuccess: boolean;
  isError: boolean;
  data?: PlatformAgentSession;
}): SessionLine {
  if (state.isError) return 'failed';
  if (!state.isSuccess || !state.data) return 'unknown';
  return state.data.empty ? 'empty' : 'kept';
}
