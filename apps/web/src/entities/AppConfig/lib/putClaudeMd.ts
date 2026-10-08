import { apiClient } from '@shared/api/client';

/**
 * Имя файла уходит ТОЛЬКО когда его ещё нет на диске и человек его выбрал
 * (П2.7). Существующий файл панель не переименовывает — сервер на такой запрос
 * отвечает 409.
 */
export async function putClaudeMd(draft: { content: string; fileName?: string }): Promise<void> {
  await apiClient.put('/claude-md', draft);
}
