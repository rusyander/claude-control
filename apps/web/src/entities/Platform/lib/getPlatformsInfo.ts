import type { PlatformsInfo } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';

/**
 * Список приезжает ЦЕЛИКОМ — с активным контуром и разовым рассказом о переносе
 * — и целиком же лежит в кеше. Отбросить лишнее здесь, как делалось раньше,
 * значило бы завести второй запрос за активным контуром и получить два ответа
 * на один вопрос: список, где контур уже активен, и поле, где ещё нет.
 */
export async function getPlatformsInfo(): Promise<PlatformsInfo> {
  const { data } = await apiClient.get<PlatformsInfo>('/platforms');
  return data;
}
