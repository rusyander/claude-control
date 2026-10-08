import { apiClient } from '@shared/api/client';

/**
 * Текст просьбы «раздели задачи», который уходит агенту по кнопке. Живёт на
 * сервере вместе с описанием формата: вторая копия инструкции в клиенте
 * разошлась бы с первой на ближайшей же правке блока.
 *
 * Проект, модель и глубину сервер спрашивает не из любопытства: по ним он решает,
 * действует ли здесь подбор модели, и называет агенту НАСТОЯЩИЙ потолок этого
 * разговора. Без них к просьбе не приложится строка о классах работы — кнопка
 * молча работала бы иначе, чем инициатива.
 */
export async function fetchSplitRequestPrompt(context: {
  path?: string;
  model?: string;
  effort?: string;
}): Promise<string> {
  const { data } = await apiClient.get<{ prompt: string }>('/chat/split/request', {
    params: context,
  });
  return data.prompt;
}
