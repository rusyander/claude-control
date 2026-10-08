import type { HandoffStarted } from '@agentdeck/contracts/chat-handoff';
import { apiClient } from '@shared/api/client';

export interface RestartSessionBody {
  projectPath: string;
  sessionId?: string;
  allowEdits: boolean;
  model?: string;
  effort?: string;
  /** Контекст переполнен: продолжение заводится сразу, агента ни о чём не просят. */
  overflow?: boolean;
}

/**
 * Исход перезапуска по кнопке: продолжение заведено сразу (файл-опора свежий)
 * или агента попросили обновить его — текст просьбы отправляет вкладка сама,
 * обычным сообщением, теми же моделью и правами.
 */
export type RestartOutcome =
  ({ mode: 'started' } & HandoffStarted) | { mode: 'requested'; prompt: string };

/** «Перезапустить сессию» из меню шапки; 409 — прогон ещё идёт. */
export async function restartSession(
  chatId: string,
  body: RestartSessionBody,
): Promise<RestartOutcome> {
  const { data } = await apiClient.post<RestartOutcome>(
    `/chat/${encodeURIComponent(chatId)}/restart`,
    body,
  );
  return data;
}
