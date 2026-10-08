import { useQueryClient, useMutation } from '@tanstack/react-query';
import { api } from '../../shared/api/client';
import type { WatcherStatus } from '@agentdeck/contracts';
import { KEY } from './api.constants';

/** Выключить. Включения на телефоне нет: это решение принимают в панели. */
export function useTurnOffWatcher() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<WatcherStatus>('/watcher', { enabled: false }),
    onSuccess: (status) => client.setQueryData(KEY, status),
    onSettled: () => client.invalidateQueries({ queryKey: KEY }),
  });
}
