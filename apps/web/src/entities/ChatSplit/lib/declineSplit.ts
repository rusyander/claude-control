import { apiClient } from '@shared/api/client';

/**
 * Отказ от разделения. Реплика агенту уходит отдельно и живёт один ход, а эта
 * отметка гасит инициативу разговора совсем: иначе следующий же прогон предложил
 * бы то же самое. Сбой глотаем — отказ и без записи сработал репликой.
 */
export async function declineSplit(chatId: string): Promise<void> {
  await apiClient.post('/chat/split/decline', { chatId }).catch(() => undefined);
}
