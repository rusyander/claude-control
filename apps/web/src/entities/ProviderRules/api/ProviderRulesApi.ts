import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ProviderRule,
  ProviderRuleDraft,
  ProviderRulesInfo,
  WriteResult,
} from '@claude-control/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

/**
 * Правила активного провайдера КАТАЛОГОМ `.mdc` (Cursor, CURSOR-1).
 *
 * Третья модель раздела инструкций. Первые две живут отдельно: один файл — на
 * `/claude-md`, список ссылок — в `entities/ProviderInstructions`. Здесь — много
 * файлов в каталоге: список правил и операции над ОДНИМ правилом (чтение,
 * создание/обновление одним PUT, удаление).
 *
 * Проектный уровень — те же данные по другому адресу: `projectId` переключает
 * набор роутов, модель ответа одна и та же.
 */

interface Scope {
  /** Задан → каталог проекта (`<проект>/.cursor/rules`), иначе глобальный. */
  projectId?: string;
}

function basePath(projectId?: string): string {
  return projectId ? `/projects/${projectId}/provider/rules` : '/provider-rules';
}

function listKey(projectId?: string): readonly string[] {
  return projectId ? queryKeys.projectProviderRules(projectId) : queryKeys.providerRules;
}

function ruleKey(path: string, projectId?: string): readonly string[] {
  return projectId ? queryKeys.projectProviderRule(projectId, path) : queryKeys.providerRule(path);
}

/** Список правил каталога + игнорируемые Cursor файлы + путь каталога. */
export function useProviderRules({ projectId }: Scope = {}) {
  return useQuery({
    queryKey: listKey(projectId),
    queryFn: async (): Promise<ProviderRulesInfo> => {
      const { data } = await apiClient.get<ProviderRulesInfo>(basePath(projectId));
      return data;
    },
  });
}

/** Одно правило: три поля frontmatter отдельно от markdown-тела. */
export function useProviderRule(path: string | undefined, { projectId }: Scope = {}) {
  return useQuery({
    queryKey: ruleKey(path ?? '', projectId),
    enabled: Boolean(path),
    queryFn: async (): Promise<ProviderRule> => {
      const { data } = await apiClient.get<ProviderRule>(`${basePath(projectId)}/rule`, {
        params: { path },
      });
      return data;
    },
  });
}

/** Создание и обновление — один и тот же PUT: путь правила и есть его идентичность. */
export function useSaveProviderRule({ projectId }: Scope = {}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (draft: ProviderRuleDraft): Promise<WriteResult> => {
      const { data } = await apiClient.put<WriteResult>(`${basePath(projectId)}/rule`, draft);
      return data;
    },
    onSuccess: (_result, draft) => {
      void queryClient.invalidateQueries({ queryKey: ruleKey(draft.path, projectId) });
      void queryClient.invalidateQueries({ queryKey: listKey(projectId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.history });
    },
    meta: { successMessage: 'toasts.saved' },
  });
}

/** Удаление правила: на сервере перед удалением делается резервная копия. */
export function useDeleteProviderRule({ projectId }: Scope = {}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (path: string): Promise<WriteResult> => {
      const { data } = await apiClient.delete<WriteResult>(`${basePath(projectId)}/rule`, {
        params: { path },
      });
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: listKey(projectId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.history });
    },
    meta: { successMessage: 'toasts.deleted' },
  });
}
