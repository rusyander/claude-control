import type { ProviderChatEvent } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';

/**
 * Поток ответа. Читается вручную, а не `EventSource`: у того нет ни отмены по
 * сигналу, ни собственного переподключения под наши правила — а рвать поток при
 * уходе со страницы нужно точно и сразу.
 *
 * Пинг-комментарии (`: ping`) пропускаются: они держат соединение живым, пока
 * CLI думает над первым словом, и событиями не являются.
 */
export async function openProviderChatStream(
  chatId: string,
  onEvent: (event: ProviderChatEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(
    `${apiClient.defaults.baseURL}/provider-chat/chats/${chatId}/stream`,
    { method: 'GET', signal },
  );
  if (!response.ok || !response.body) return;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;

    buffer += decoder.decode(chunk.value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';

    for (const frame of frames) {
      const line = frame.split('\n').find((part) => part.startsWith('data:'));
      if (!line) continue;
      try {
        onEvent(JSON.parse(line.slice(5).trim()) as ProviderChatEvent);
      } catch {
        // Неразборный кадр пропускаем: поток от этого рваться не должен.
      }
    }
  }
}
