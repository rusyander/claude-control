import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';
import { getProposal } from '../lib/getProposal';

export function useGlobalProposal(id: string, enabled: boolean) {
  return useQuery({
    queryKey: [...queryKeys.globalLayer, id, 'proposal'],
    queryFn: () => getProposal(id),
    enabled,
  });
}
