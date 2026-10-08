import { useQuery } from '@tanstack/react-query';
import { getLive } from '../lib/getLive';

/** Живой срез: запущенные процессы. Обновляется часто — он дешёвый. */
export function useLiveAgents() {
  return useQuery({
    queryKey: ['analytics', 'live'],
    queryFn: getLive,
    refetchInterval: 5_000,
    staleTime: 0,
  });
}
