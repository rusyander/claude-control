import type { ProjectGroupChoiceView } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';

export async function getChoice(path: string, group?: string): Promise<ProjectGroupChoiceView> {
  const { data } = await apiClient.get<ProjectGroupChoiceView>('/projects/group-choice', {
    params: { path, ...(group ? { group } : {}) },
  });
  return data;
}

/**
 * Какая сторона пары действует в проекте. Выбор у каждой пары свой: `group`
 * (id любой стороны) называет пару для `groupKey`; `choices` — выбор всех пар.
 */
export function useProjectGroupChoice(path: string | undefined, group?: string) {
  return useQuery({
    queryKey: queryKeys.groupChoice(path ?? '', group),
    queryFn: () => getChoice(path ?? '', group),
    enabled: Boolean(path),
  });
}
