import { apiClient } from '@shared/api/client';

/** Адрес выгрузки разговора файлом — по нему браузер скачивает Markdown/JSON. */
export function chatExportUrl(chatId: string, format: 'md' | 'json'): string {
  return `${apiClient.defaults.baseURL}/chat/${chatId}/export?format=${format}`;
}
