import { apiClient } from '@shared/api/client';

/** Адрес файла для встроенного просмотра: картинки и документы браузер тянет сам. */
export function artifactUrl(chatId: string, name: string): string {
  return `${apiClient.defaults.baseURL}/chat/${chatId}/artifact?name=${encodeURIComponent(name)}`;
}
