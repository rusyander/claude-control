import { apiClient } from '@shared/api/client';

/**
 * Текст просьбы «закрой этап и подготовь продолжение», который уходит агенту по
 * кнопке. Живёт на сервере вместе с описанием формата блока: вторая копия
 * инструкции в клиенте разошлась бы с первой на ближайшей же правке.
 */
export async function fetchHandoffRequestPrompt(): Promise<string> {
  const { data } = await apiClient.get<{ prompt: string }>('/chat/handoff/request');
  return data.prompt;
}
