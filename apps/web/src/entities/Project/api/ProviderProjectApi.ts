import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ProviderPermissionDraft,
  ProviderPermissionInfo,
  ProviderEnvInfo,
  ProviderEnvVar,
  ProviderMcpInfo,
  ProviderProjectInfo,
  ProviderProjectInstructions,
  UniversalMcpServerDraft,
  WriteResult,
} from '@claude-control/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

/**
 * Проектный уровень конфигурации у НЕ-Claude провайдеров (COMMON-2 + GEMINI-2/3).
 *
 * Claude остаётся на своих запросах (`ProjectConfigApi`: CLAUDE.md, .mcp.json,
 * права) — здесь универсальная ветка `/projects/:id/provider/*`: инструкции
 * проекта (AGENTS.md / GEMINI.md), MCP-серверы переносимого субсета, а у Gemini
 * ещё переменные окружения (`.gemini/.env`) и права (`.gemini/settings.json`) из
 * проектных файлов провайдера. Какие разделы есть у активного провайдера,
 * говорит сам сервер (`sections`), а не клиент: формат мы не угадываем.
 */

export function useProviderProject(projectId: string) {
  return useQuery({
    queryKey: queryKeys.projectProvider(projectId),
    queryFn: async () => {
      const { data } = await apiClient.get<ProviderProjectInfo>(`/projects/${projectId}/provider`);
      return data;
    },
    enabled: Boolean(projectId),
  });
}

// --- Инструкции проекта ---

export function useProviderProjectInstructions(projectId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.projectProviderInstructions(projectId),
    queryFn: async () => {
      const { data } = await apiClient.get<ProviderProjectInstructions>(
        `/projects/${projectId}/provider/instructions`,
      );
      return data;
    },
    enabled: Boolean(projectId) && enabled,
  });
}

export function useUpdateProviderProjectInstructions(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (content: string) => {
      const { data } = await apiClient.put<WriteResult>(
        `/projects/${projectId}/provider/instructions`,
        { content },
      );
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.projectProviderInstructions(projectId),
      });
    },
    meta: { successMessage: 'toasts.saved' },
  });
}

// --- MCP-серверы проекта ---

export function useProviderProjectMcp(projectId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.projectProviderMcp(projectId),
    queryFn: async () => {
      const { data } = await apiClient.get<ProviderMcpInfo>(`/projects/${projectId}/provider/mcp`);
      return data;
    },
    enabled: Boolean(projectId) && enabled,
  });
}

/** Инвалидация списка серверов проекта после любой правки. */
function useInvalidateProviderProjectMcp(projectId: string) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: queryKeys.projectProviderMcp(projectId) });
}

export function useCreateProviderProjectMcp(projectId: string) {
  const invalidate = useInvalidateProviderProjectMcp(projectId);
  return useMutation({
    mutationFn: async (draft: UniversalMcpServerDraft) => {
      const { data } = await apiClient.post<WriteResult>(
        `/projects/${projectId}/provider/mcp`,
        draft,
      );
      return data;
    },
    onSuccess: () => void invalidate(),
    meta: { successMessage: 'toasts.created' },
  });
}

export function useUpdateProviderProjectMcp(projectId: string) {
  const invalidate = useInvalidateProviderProjectMcp(projectId);
  return useMutation({
    mutationFn: async (input: { id: string; draft: UniversalMcpServerDraft }) => {
      const { data } = await apiClient.put<WriteResult>(
        `/projects/${projectId}/provider/mcp/${encodeURIComponent(input.id)}`,
        input.draft,
      );
      return data;
    },
    onSuccess: () => void invalidate(),
    meta: { successMessage: 'toasts.saved' },
  });
}

export function useDeleteProviderProjectMcp(projectId: string) {
  const invalidate = useInvalidateProviderProjectMcp(projectId);
  return useMutation({
    mutationFn: async (id: string) => {
      const { data } = await apiClient.delete<WriteResult>(
        `/projects/${projectId}/provider/mcp/${encodeURIComponent(id)}`,
      );
      return data;
    },
    onSuccess: () => void invalidate(),
    meta: { successMessage: 'toasts.deleted' },
  });
}

// --- Переменные окружения проекта (GEMINI-3: <проект>/.gemini/.env) ---

export function useProviderProjectEnv(projectId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.projectProviderEnv(projectId),
    queryFn: async () => {
      const { data } = await apiClient.get<ProviderEnvInfo>(`/projects/${projectId}/provider/env`);
      return data;
    },
    enabled: Boolean(projectId) && enabled,
  });
}

/** Bulk-сохранение полного набора переменных проекта (как и у глобального раздела). */
export function useSaveProviderProjectEnv(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: ProviderEnvVar[]) => {
      const { data } = await apiClient.put<WriteResult>(`/projects/${projectId}/provider/env`, {
        vars,
      });
      return data;
    },
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: queryKeys.projectProviderEnv(projectId) }),
    meta: { successMessage: 'toasts.saved' },
  });
}

// --- Права/аппрувы проекта -------------------------------------------------
// GEMINI-2: `<проект>/.gemini/settings.json`; OPENCODE-1: ключ `permission` в
// `<проект>/opencode.json`. Модель выбирает СЕРВЕР (поле `kind`), клиент только
// рисует нужную форму — поэтому тип ответа общий (`ProviderPermissionInfo`).

export function useProviderProjectPermissions(projectId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.projectProviderPermissions(projectId),
    queryFn: async () => {
      const { data } = await apiClient.get<ProviderPermissionInfo>(
        `/projects/${projectId}/provider/permissions`,
      );
      return data;
    },
    enabled: Boolean(projectId) && enabled,
  });
}

export function useSaveProviderProjectPermissions(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (draft: ProviderPermissionDraft) => {
      const { data } = await apiClient.put<WriteResult>(
        `/projects/${projectId}/provider/permissions`,
        draft,
      );
      return data;
    },
    onSuccess: () =>
      void queryClient.invalidateQueries({
        queryKey: queryKeys.projectProviderPermissions(projectId),
      }),
    meta: { successMessage: 'toasts.saved' },
  });
}
