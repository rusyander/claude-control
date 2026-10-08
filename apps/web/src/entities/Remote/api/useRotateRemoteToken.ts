import { useRemoteMutation } from './useRemoteMutation';
import { apiClient } from '@shared/api/client';
import type { RemoteAccessStatus } from '@agentdeck/contracts';

/**
 * Новый токен. Спаренные телефоны после этого перестают ходить — это и есть
 * кнопка «я потерял телефон», а не косметическая ротация.
 */
export function useRotateRemoteToken() {
  return useRemoteMutation(async () => {
    const { data } = await apiClient.post<RemoteAccessStatus>('/remote/token');
    return data;
  });
}
