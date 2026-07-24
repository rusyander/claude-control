import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ProviderInstructionsFile,
  ProviderInstructionsInfo,
  WriteResult,
} from '@claude-control/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

/**
 * Инструкции-СПИСКОМ ССЫЛОК активного провайдера (Aider, AIDER-1).
 *
 * У Claude/Codex/Gemini/OpenCode инструкции — один файл, и они живут на роуте
 * `/claude-md` со своей страницей. У Aider единого файла нет: файлы контекста
 * перечисляются опцией `read` в `.aider.conf.yml`. Поэтому здесь два уровня
 * запросов: сам СПИСОК (bulk-PUT: добавить/убрать/переставить сводятся к одному
 * запросу) и СОДЕРЖИМОЕ одного перечисленного файла.
 *
 * Проектный уровень (AIDER-4) — те же данные по другому адресу: `projectId`
 * переключает набор роутов, модель ответа одна и та же.
 */

interface Scope {
  /** Задан → проектный уровень (`<проект>/.aider.conf.yml`), иначе глобальный. */
  projectId?: string;
}

function basePath(projectId?: string): string {
  return projectId ? `/projects/${projectId}/provider/instructions-list` : '/provider-instructions';
}

function listKey(projectId?: string): readonly string[] {
  return projectId
    ? queryKeys.projectProviderInstructionsList(projectId)
    : queryKeys.providerInstructions;
}

function fileKey(raw: string, projectId?: string): readonly string[] {
  return projectId
    ? queryKeys.projectProviderInstructionsListFile(projectId, raw)
    : queryKeys.providerInstructionsFile(raw);
}

/** Список ссылок на файлы инструкций + метаданные конфигурации. */
export function useProviderInstructions({ projectId }: Scope = {}) {
  return useQuery({
    queryKey: listKey(projectId),
    queryFn: async (): Promise<ProviderInstructionsInfo> => {
      const { data } = await apiClient.get<ProviderInstructionsInfo>(basePath(projectId));
      return data;
    },
  });
}

/** Bulk-сохранение полного списка (порядок значим — это порядок подключения). */
export function useSaveProviderInstructions({ projectId }: Scope = {}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (entries: string[]): Promise<WriteResult> => {
      const { data } = await apiClient.put<WriteResult>(basePath(projectId), { entries });
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: listKey(projectId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.overview });
      void queryClient.invalidateQueries({ queryKey: queryKeys.history });
    },
    meta: { successMessage: 'toasts.saved' },
  });
}

/**
 * Содержимое ОДНОГО перечисленного файла. Запрос включается только когда запись
 * выбрана и её файл существует: панель не создаёт файлов, которых нет.
 */
export function useProviderInstructionsFile(raw: string | undefined, { projectId }: Scope = {}) {
  return useQuery({
    queryKey: fileKey(raw ?? '', projectId),
    enabled: Boolean(raw),
    queryFn: async (): Promise<ProviderInstructionsFile> => {
      const { data } = await apiClient.get<ProviderInstructionsFile>(
        `${basePath(projectId)}/file`,
        { params: { path: raw } },
      );
      return data;
    },
  });
}

/** Запись содержимого перечисленного файла (бэкап + атомарно на сервере). */
export function useSaveProviderInstructionsFile({ projectId }: Scope = {}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (draft: { path: string; content: string }): Promise<WriteResult> => {
      const { data } = await apiClient.put<WriteResult>(`${basePath(projectId)}/file`, draft);
      return data;
    },
    onSuccess: (_result, draft) => {
      void queryClient.invalidateQueries({ queryKey: fileKey(draft.path, projectId) });
      void queryClient.invalidateQueries({ queryKey: listKey(projectId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.history });
    },
    meta: { successMessage: 'toasts.saved' },
  });
}
