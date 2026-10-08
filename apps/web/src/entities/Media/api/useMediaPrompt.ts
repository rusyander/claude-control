import type { MediaPromptKind } from './MediaApi.types';
import { apiClient } from '@shared/api/client';
import { useMutation } from '@tanstack/react-query';

/**
 * Готовая просьба к агенту. Собирает её СЕРВЕР: правила лежат в каталоге промптов
 * (единственное место, где человек их правит), и вторая сборка здесь разошлась бы
 * с ними после первой же правки.
 */
export async function mediaPrompt(
  kind: MediaPromptKind,
  topic: string,
  reviseOf?: string,
): Promise<string> {
  const { data } = await apiClient.post<{ prompt: string }>('/media/prompt', {
    kind,
    topic,
    ...(reviseOf ? { reviseOf } : {}),
  });
  return data.prompt;
}

export function useMediaPrompt() {
  return useMutation({
    mutationFn: ({
      kind,
      topic,
      reviseOf,
    }: {
      kind: MediaPromptKind;
      topic: string;
      reviseOf?: string;
    }) => mediaPrompt(kind, topic, reviseOf),
  });
}
