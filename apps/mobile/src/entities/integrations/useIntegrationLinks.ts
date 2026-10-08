import { useQuery } from '@tanstack/react-query';
import { api } from '../../shared/api/client';
import type { IntegrationLinks } from '@agentdeck/contracts';

/** Привязки проекта и его групп. Нет проекта — не спрашиваем. */
export function useIntegrationLinks(projectPath: string | undefined) {
  return useQuery({
    queryKey: ['integration-links', projectPath],
    queryFn: () => api.get<IntegrationLinks>('/integrations/links', { path: projectPath }),
    enabled: Boolean(projectPath),
    staleTime: 60_000,
    // Интеграции могут быть не настроены вовсе — это не повод повторять запрос.
    retry: false,
  });
}
