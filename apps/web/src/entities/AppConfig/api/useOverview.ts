import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';
import { getOverview } from '../lib/getOverview';

export function useOverview() {
  return useQuery({ queryKey: queryKeys.overview, queryFn: getOverview });
}
