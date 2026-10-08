import type { MediaImage } from '@agentdeck/contracts';
import { api } from '../../shared/api/client';

/**
 * Рисование — минуты, а обычный потолок запроса телефона 20 с: он оборвал бы
 * удачный запрос и списал бы деньги ключа впустую. Тот же потолок, что у панели.
 */
export const IMAGE_TIMEOUT_MS = 190_000;

/** Панель рисует сама: результат — запись и файл у неё, не реплика в переписке. */
export function createImage(request: { chatId: string; prompt: string }): Promise<MediaImage> {
  return api.post<MediaImage>('/media/images', request, { timeoutMs: IMAGE_TIMEOUT_MS });
}
