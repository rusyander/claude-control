import type { HandoffStarted } from '@agentdeck/contracts/chat-handoff';
import { api } from '../../shared/api/client';

/**
 * Исход «чистой сессии» — тот же ответ, что получает панель: продолжение заведено
 * сразу или агента сначала просят обновить файл-опору (текст просьбы уходит
 * обычным сообщением, теми же моделью и правами).
 */
export type RestartOutcome =
  ({ mode: 'started' } & HandoffStarted) | { mode: 'requested'; prompt: string };

/** Перезапуск разговора Claude; 409 — прогон ещё идёт. */
export function restartChat(
  chatId: string,
  body: {
    projectPath: string;
    sessionId?: string;
    allowEdits: boolean;
    model?: string;
    effort?: string;
  },
): Promise<RestartOutcome> {
  return api.post<RestartOutcome>(`/chat/${encodeURIComponent(chatId)}/restart`, body);
}
