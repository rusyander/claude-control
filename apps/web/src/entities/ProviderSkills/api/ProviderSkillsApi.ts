import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ProviderSkill,
  ProviderSkillDraft,
  ProviderSkillsInfo,
  WriteResult,
} from '@claude-control/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

/**
 * Скиллы активного провайдера (OpenCode, OPENCODE-5).
 *
 * Это НЕ раздел скиллов самой панели для Claude (`entities/Skill`, `/api/skills`)
 * — тот не тронут. Здесь скиллы чужого CLI: каталог папок со `SKILL.md` (список,
 * чтение, создание/обновление, удаление). Проектный уровень — те же данные по
 * другому адресу.
 */

interface Scope {
  /** Задан → каталог скиллов проекта, иначе глобальный. */
  projectId?: string;
}

function basePath(projectId?: string): string {
  return projectId ? `/projects/${projectId}/provider/skills` : '/provider-skills';
}

function infoKey(projectId?: string): readonly string[] {
  return projectId ? queryKeys.projectProviderSkills(projectId) : queryKeys.providerSkills;
}

function skillKey(path: string, projectId?: string): readonly string[] {
  return projectId
    ? queryKeys.projectProviderSkill(projectId, path)
    : queryKeys.providerSkill(path);
}

/** Список скиллов каталога + путь каталога и прочие каталоги загрузки. */
export function useProviderSkills({ projectId }: Scope = {}) {
  return useQuery({
    queryKey: infoKey(projectId),
    queryFn: async (): Promise<ProviderSkillsInfo> => {
      const { data } = await apiClient.get<ProviderSkillsInfo>(basePath(projectId));
      return data;
    },
  });
}

/** Один скилл целиком: поля шапки отдельно от markdown-тела. */
export function useProviderSkill(path: string | undefined, { projectId }: Scope = {}) {
  return useQuery({
    queryKey: skillKey(path ?? '', projectId),
    enabled: Boolean(path),
    queryFn: async (): Promise<ProviderSkill> => {
      const { data } = await apiClient.get<ProviderSkill>(`${basePath(projectId)}/skill`, {
        params: { path },
      });
      return data;
    },
  });
}

/** Создание и обновление — один и тот же PUT: путь скилла и есть его идентичность. */
export function useSaveProviderSkill({ projectId }: Scope = {}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (draft: ProviderSkillDraft): Promise<WriteResult> => {
      const { data } = await apiClient.put<WriteResult>(`${basePath(projectId)}/skill`, draft);
      return data;
    },
    onSuccess: (_result, draft) => {
      void queryClient.invalidateQueries({ queryKey: skillKey(draft.path, projectId) });
      void queryClient.invalidateQueries({ queryKey: infoKey(projectId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.history });
    },
    meta: { successMessage: 'toasts.saved' },
  });
}

/** Удаление скилла: на сервере перед удалением делается резервная копия папки. */
export function useDeleteProviderSkill({ projectId }: Scope = {}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (path: string): Promise<WriteResult> => {
      const { data } = await apiClient.delete<WriteResult>(`${basePath(projectId)}/skill`, {
        params: { path },
      });
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: infoKey(projectId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.history });
    },
    meta: { successMessage: 'toasts.deleted' },
  });
}
