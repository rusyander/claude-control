import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';
import { fetchProjectRegistry } from '../lib/fetchProjectRegistry';

/** Зарегистрированные проекты. */
export function useProjectRegistry() {
  return useQuery({ queryKey: queryKeys.projects, queryFn: fetchProjectRegistry });
}
