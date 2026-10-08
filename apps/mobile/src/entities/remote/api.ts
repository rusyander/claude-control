import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { RemoteAccessStatus } from '@agentdeck/contracts';
import { api } from '../../shared/api/client';
import { isConfigured } from '../../shared/api/connection';

/** «На связи» в настройках живёт этим опросом: без него статус не менялся до ручного обновления. */
const REMOTE_POLL_MS = 15_000;

/**
 * Удалённый доступ глазами телефона: включён ли он, каким адресом панель себя
 * считает и какие устройства к ней привязаны.
 *
 * Токен в ответе есть, но приложению он не нужен — свой оно уже сохранило при
 * спаривании. Показывать его на телефоне незачем: перенести его отсюда некуда.
 */

export function useRemote(): UseQueryResult<RemoteAccessStatus> {
  return useQuery({
    queryKey: ['remote'],
    queryFn: () => api.get<RemoteAccessStatus>('/remote'),
    staleTime: 10_000,
    refetchInterval: REMOTE_POLL_MS,
    enabled: isConfigured(),
  });
}
