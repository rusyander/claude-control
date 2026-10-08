import { useQuery } from '@tanstack/react-query';
import type { RemoteAccessStatus } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

/**
 * Удалённый доступ: включён ли он, каким токеном открывается и какие телефоны
 * получают уведомления.
 *
 * Каждая операция возвращает уже НОВОЕ состояние, поэтому кэш обновляется
 * ответом, без запроса следом: смена токена и отвязка устройства меняют один и
 * тот же объект, и второй запрос показал бы промежуточную картину.
 */

async function getRemote(): Promise<RemoteAccessStatus> {
  const { data } = await apiClient.get<RemoteAccessStatus>('/remote');
  return data;
}

export function useRemoteAccess() {
  return useQuery({ queryKey: queryKeys.remote, queryFn: getRemote });
}
