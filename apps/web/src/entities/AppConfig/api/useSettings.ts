import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';
import { getSettings } from '../lib/getSettings';

export function useSettings() {
  return useQuery({ queryKey: queryKeys.settings, queryFn: getSettings });
}
