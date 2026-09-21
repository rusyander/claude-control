import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  McpServer,
  McpServerDraft,
  PermissionDraft,
  PermissionRule,
  ProjectRulesAnswer,
  WriteResult,
} from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

/**
 * Конфиги конкретного проекта: его CLAUDE.md, MCP-серверы (.mcp.json) и права
 * (.claude/settings.json). На сервере они читаются и пишутся теми же доменными
 * функциями, что и пользовательский уровень, только с проектными путями.
 *
 * Проектная область — «сырое» чтение/правка файлов проекта: групп и
 * disabled-оверлеев пользовательского уровня здесь нет.
 */

// --- Правила проекта: CLAUDE.md целиком ---

export function useProjectRules(projectId: string) {
  return useQuery({
    queryKey: queryKeys.projectRules(projectId),
    queryFn: async () => {
      // Не только текст: имя файла правил решается ключом `instructionFiles`, и
      // экран обязан назвать, какой файл читает CLI (П2.7).
      const { data } = await apiClient.get<ProjectRulesAnswer>(`/projects/${projectId}/rules`);
      return data;
    },
    enabled: Boolean(projectId),
  });
}

export function useUpdateProjectRules(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    // Имя уходит ТОЛЬКО когда файла ещё нет: существующий панель не
    // переименовывает, и сервер на такую просьбу отвечает 409.
    mutationFn: async (draft: { content: string; fileName?: string }) => {
      const { data } = await apiClient.put<WriteResult>(`/projects/${projectId}/rules`, draft);
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projectRules(projectId) });
    },
    meta: { successMessage: 'toasts.saved' },
  });
}

// --- MCP-серверы проекта ---

export function useProjectMcp(projectId: string) {
  return useQuery({
    queryKey: queryKeys.projectMcp(projectId),
    queryFn: async () => {
      const { data } = await apiClient.get<McpServer[]>(`/projects/${projectId}/mcp`);
      return data;
    },
    enabled: Boolean(projectId),
  });
}

/** Инвалидация списка серверов проекта после любой правки. */
function useInvalidateMcp(projectId: string) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: queryKeys.projectMcp(projectId) });
}

export function useCreateProjectMcp(projectId: string) {
  const invalidate = useInvalidateMcp(projectId);
  return useMutation({
    mutationFn: async (draft: McpServerDraft) => {
      const { data } = await apiClient.post<WriteResult>(`/projects/${projectId}/mcp`, draft);
      return data;
    },
    onSuccess: () => void invalidate(),
    meta: { successMessage: 'toasts.created' },
  });
}

export function useUpdateProjectMcp(projectId: string) {
  const invalidate = useInvalidateMcp(projectId);
  return useMutation({
    mutationFn: async (input: { id: string; draft: McpServerDraft }) => {
      const { data } = await apiClient.put<WriteResult>(
        `/projects/${projectId}/mcp/${encodeURIComponent(input.id)}`,
        input.draft,
      );
      return data;
    },
    onSuccess: () => void invalidate(),
    meta: { successMessage: 'toasts.saved' },
  });
}

export function useDeleteProjectMcp(projectId: string) {
  const invalidate = useInvalidateMcp(projectId);
  return useMutation({
    mutationFn: async (id: string) => {
      const { data } = await apiClient.delete<WriteResult>(
        `/projects/${projectId}/mcp/${encodeURIComponent(id)}`,
      );
      return data;
    },
    onSuccess: () => void invalidate(),
    meta: { successMessage: 'toasts.deleted' },
  });
}

export function useSetProjectMcpEnabled(projectId: string) {
  const invalidate = useInvalidateMcp(projectId);
  return useMutation({
    mutationFn: async (input: { id: string; isEnabled: boolean }) => {
      const { data } = await apiClient.post<WriteResult>(
        `/projects/${projectId}/mcp/${encodeURIComponent(input.id)}/enabled`,
        { isEnabled: input.isEnabled },
      );
      return data;
    },
    onSuccess: () => void invalidate(),
    meta: { successMessage: 'toasts.updated' },
  });
}

// --- Права проекта ---

export function useProjectPermissions(projectId: string) {
  return useQuery({
    queryKey: queryKeys.projectPermissions(projectId),
    queryFn: async () => {
      const { data } = await apiClient.get<PermissionRule[]>(`/projects/${projectId}/permissions`);
      return data;
    },
    enabled: Boolean(projectId),
  });
}

/** Инвалидация списка прав проекта после любой правки. */
function useInvalidatePermissions(projectId: string) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: queryKeys.projectPermissions(projectId) });
}

export function useCreateProjectPermission(projectId: string) {
  const invalidate = useInvalidatePermissions(projectId);
  return useMutation({
    mutationFn: async (draft: PermissionDraft) => {
      const { data } = await apiClient.post<WriteResult>(
        `/projects/${projectId}/permissions`,
        draft,
      );
      return data;
    },
    onSuccess: () => void invalidate(),
    meta: { successMessage: 'toasts.created' },
  });
}

export function useUpdateProjectPermission(projectId: string) {
  const invalidate = useInvalidatePermissions(projectId);
  return useMutation({
    mutationFn: async (input: { id: string; draft: PermissionDraft }) => {
      const { data } = await apiClient.put<WriteResult>(
        `/projects/${projectId}/permissions/${encodeURIComponent(input.id)}`,
        input.draft,
      );
      return data;
    },
    onSuccess: () => void invalidate(),
    meta: { successMessage: 'toasts.saved' },
  });
}

export function useDeleteProjectPermission(projectId: string) {
  const invalidate = useInvalidatePermissions(projectId);
  return useMutation({
    mutationFn: async (id: string) => {
      const { data } = await apiClient.delete<WriteResult>(
        `/projects/${projectId}/permissions/${encodeURIComponent(id)}`,
      );
      return data;
    },
    onSuccess: () => void invalidate(),
    meta: { successMessage: 'toasts.deleted' },
  });
}
