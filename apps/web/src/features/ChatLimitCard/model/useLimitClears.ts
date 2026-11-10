import { useEffect } from 'react';
import type { ChatMessage } from '@agentdeck/contracts';
import { useCoreTaskView } from '@entities/CoreTask';
import type { StreamState } from '@shared/lib/chat-stream';
import { answeredAfterReset, limitHolds, resetAtOf } from './chatLimit';

/**
 * Снять ошибку лимита, когда ответ после сброса лёг в ленту открытого чата (P171). Ход после
 * сброса ведёт ядро, а не прогон панели: прогон так и стоит с ошибкой окна, и без этого карточка
 * «лимит» висела бы над пришедшим ответом. Снятие — то же, что «Закрыть» у ошибки (`dismissError`):
 * ничего не шлёт и не повторяет.
 */
export function useLimitClears(
  stream: Pick<StreamState, 'limitHit' | 'error' | 'limitResetsAt'>,
  messages: readonly Pick<ChatMessage, 'role' | 'timestamp'>[],
  coreTaskId: string | undefined,
  onClear: (() => void) | undefined,
): void {
  const holds = limitHolds(stream);
  const { view } = useCoreTaskView(holds ? coreTaskId : undefined);
  const answered = holds && answeredAfterReset(messages, resetAtOf(stream, view));
  useEffect(() => {
    if (answered) onClear?.();
    // Ключ — сам факт ответа: обработчик пересоздаётся каждым кадром страницы.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answered]);
}
