import { apiClient } from '@shared/api/client';

/** Переключить автопродолжение этого разговора. */
export async function setHandoffAuto(
  keys: { chatId?: string; sessionId?: string },
  enabled: boolean,
): Promise<{ auto: boolean; depth: number }> {
  const { data } = await apiClient.post<{ auto: boolean; depth: number }>('/chat/handoff/auto', {
    ...keys,
    enabled,
  });
  return data;
}
