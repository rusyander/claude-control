import { chatExportUrl } from '@entities/Chat';

/**
 * Выгрузка разговора файлом: браузер скачивает Markdown/JSON, собранный
 * сервером из всей переписки. Осмысленно только у сохранённого разговора.
 */
export function downloadChatExport(chatId: string, format: 'md' | 'json'): void {
  const link = document.createElement('a');
  link.href = chatExportUrl(chatId, format);
  link.download = '';
  document.body.appendChild(link);
  link.click();
  link.remove();
}
