import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { Project } from '@agentdeck/contracts';
import { api } from '../../shared/api/client';

export const REGISTRY_KEY = ['projects', 'registry'] as const;

/**
 * Реестр проектов панели — тот же список, что в разделе «Проекты» на
 * компьютере. На телефоне он основа вкладки: человек видит свои проекты, а не
 * каждую временную папку, где когда-то запускался агент.
 */
export function useProjectRegistry(): UseQueryResult<Project[]> {
  return useQuery({
    queryKey: REGISTRY_KEY,
    queryFn: () => api.get<Project[]>('/projects'),
    staleTime: 60_000,
  });
}
