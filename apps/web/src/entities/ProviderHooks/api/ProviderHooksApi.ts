import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ProviderHookRulesDraft,
  ProviderHooksDraft,
  ProviderHooksInfo,
  WriteResult,
} from '@claude-control/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

/**
 * Хуки активного провайдера в модели «ключ конфига» (OpenCode, OPENCODE-3).
 *
 * Это НЕ хуки Claude: у них своя богатая модель и свои маршруты (`entities/Hook`,
 * `/api/hooks`) — они не тронуты. Здесь форм две, и какую рисовать, говорит поле
 * `shape` ответа: `opencode-events` (ключ `experimental.hook`, два события,
 * действия-argv, только чтение) либо `event-rules` (плоский список правил
 * «событие → команда»: `hooks` в settings.json у Qwen, `[[hooks]]` в config.toml
 * у Kimi).
 *
 * Проектный уровень — те же данные по другому адресу: `projectId` переключает
 * набор роутов, модель ответа одна и та же.
 */

interface Scope {
  /** Задан → конфиг проекта (`<проект>/opencode.json`), иначе глобальный. */
  projectId?: string;
}

function basePath(projectId?: string): string {
  return projectId ? `/projects/${projectId}/provider/hooks` : '/provider-hooks';
}

function infoKey(projectId?: string): readonly string[] {
  return projectId ? queryKeys.projectProviderHooks(projectId) : queryKeys.providerHooks;
}

/** Оба события целиком плюс всё, что панель сохраняет только для чтения. */
export function useProviderHooks({ projectId }: Scope = {}) {
  return useQuery({
    queryKey: infoKey(projectId),
    queryFn: async (): Promise<ProviderHooksInfo> => {
      const { data } = await apiClient.get<ProviderHooksInfo>(basePath(projectId));
      return data;
    },
  });
}

/**
 * Запись обоих событий одним PUT: черновик — это желаемое состояние целиком.
 * Пустое событие удаляет свой ключ из файла (панель не пишет пустых объектов).
 */
export function useSaveProviderHooks({ projectId }: Scope = {}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      draft: ProviderHooksDraft | ProviderHookRulesDraft,
    ): Promise<WriteResult> => {
      const { data } = await apiClient.put<WriteResult>(basePath(projectId), draft);
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: infoKey(projectId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.history });
    },
    meta: { successMessage: 'toasts.saved' },
  });
}
