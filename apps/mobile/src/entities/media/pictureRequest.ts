import { api } from '../../shared/api/client';

/**
 * Готовая просьба агенту. Собирает сервер: правила живут в каталоге промптов, и
 * вторая сборка на телефоне разошлась бы с ними после первой правки.
 */
export async function pictureRequest(topic: string): Promise<string> {
  const { prompt } = await api.post<{ prompt: string }>('/media/prompt', {
    kind: 'picture',
    topic,
  });
  return prompt;
}
