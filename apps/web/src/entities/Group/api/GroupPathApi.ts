import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  GroupPathView,
  PathResourceType,
  PathStep,
  PathStepDraftBody,
  PathStepProposal,
  ResourceSummary,
} from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

// «Путь» группы: собранный сервером список шагов, правка своих шагов одним
// запросом, ассистент шага и «повышение» шага до настоящего ресурса.

async function getPath(id: string): Promise<GroupPathView> {
  const { data } = await apiClient.get<GroupPathView>(`/groups/${id}/path`);
  return data;
}

/** Порядок шагов собирает сервер (`buildPath`) — клиент его не пересчитывает. */
export function useGroupPath(id: string) {
  return useQuery({ queryKey: queryKeys.groupPath(id), queryFn: () => getPath(id) });
}

/** Весь список своих шагов одним запросом: вставка, перенос, правка и удаление — одна запись. */
export function useSaveGroupPathSteps(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (steps: PathStep[]) => {
      const { data } = await apiClient.put<GroupPathView>(`/groups/${id}/path/steps`, { steps });
      return data;
    },
    onSuccess: (view) => queryClient.setQueryData(queryKeys.groupPath(id), view),
    meta: { successMessage: 'toasts.saved' },
  });
}

export interface PathStepDraftResult {
  conversationId: string;
  proposal: PathStepProposal;
}

/** Один круг разговора с ассистентом шага; ответ человека на вопросы — следующий круг. */
export function useDraftPathStep(id: string) {
  return useMutation({
    mutationFn: async (request: PathStepDraftBody) => {
      const { data } = await apiClient.post<PathStepDraftResult>(
        `/groups/${id}/path/draft`,
        request,
      );
      return data;
    },
  });
}

/** Шаг становится скиллом, хуком или правилом и входит в группу участником. */
export function usePromotePathStep(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { stepId: string; type: PathResourceType; draft: string }) => {
      const { data } = await apiClient.post<GroupPathView>(`/groups/${id}/path/promote`, input);
      return data;
    },
    onSuccess: (view) => {
      queryClient.setQueryData(queryKeys.groupPath(id), view);
      for (const key of [queryKeys.groups, queryKeys.skills, queryKeys.rules, queryKeys.hooks]) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    },
    meta: { successMessage: 'groupPath.promoted' },
  });
}

/**
 * Сводка ресурса «что делает / как работает». Зовётся лениво — только когда
 * строку раскрыли или участник показан: промах кэша стоит серверу вызова модели.
 */
export function useResourceSummary(
  type: PathResourceType,
  id: string,
  enabled = true,
  /** Проект, где лежит ресурс; нет — общие каталоги. */
  project?: string,
) {
  return useQuery({
    // Проект — часть ключа: одноимённые ресурсы проекта и общий — разные файлы.
    queryKey: [...queryKeys.resourceSummary(type, id), project ?? ''],
    queryFn: async () => {
      const { data } = await apiClient.get<ResourceSummary>('/resources/summary', {
        params: { type, id, ...(project ? { path: project } : {}) },
      });
      return data;
    },
    enabled,
    // Сводка меняется только вместе с файлом, а файл — редко: не переспрашиваем.
    staleTime: Infinity,
    retry: false,
  });
}
