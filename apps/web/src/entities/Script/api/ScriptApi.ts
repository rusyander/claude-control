import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';

export interface ScriptFile {
  id: string;
  name: string;
  extension: string;
  path: string;
  sizeBytes: number;
  modifiedAt: string;
  description?: string;
  isUsed: boolean;
  /** Тест или фикстура (`tests/`, `*.test.*`): к хукам не привязывают по замыслу. */
  isTest: boolean;
}

/** Ответ записи/удаления: путь резервной копии называет тост. */
interface ScriptWriteResult {
  ok: boolean;
  backupPath?: string;
  needsRestart?: boolean;
}

const scriptsKey = ['scripts'] as const;

/** Кодируем каждый сегмент, но сохраняем слэши: id скрипта может быть вложенным путём. */
function encodeScriptId(id: string): string {
  return id.split('/').map(encodeURIComponent).join('/');
}

export function useScripts() {
  return useQuery({
    queryKey: scriptsKey,
    queryFn: async () => {
      const { data } = await apiClient.get<ScriptFile[]>('/scripts');
      return data;
    },
  });
}

/** Содержимое файла грузится отдельно: список не должен тянуть весь код. */
export function useScriptContent(id: string | undefined) {
  return useQuery({
    queryKey: ['scripts', id, 'content'],
    queryFn: async () => {
      const { data } = await apiClient.get<{ content: string }>(
        `/scripts/${encodeScriptId(id ?? '')}`,
      );
      return data.content;
    },
    enabled: Boolean(id),
  });
}

/**
 * Результат запроса возвращается наружу: общий MutationCache читает из него
 * `backupPath` и называет копию в тосте. Раньше мутации возвращали undefined —
 * и у скриптов, единственных, тост молчал о копии, которую подсказка обещала.
 */
function useScriptMutation<TInput>(
  request: (input: TInput) => Promise<ScriptWriteResult>,
  successMessage: string,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: scriptsKey });
      void queryClient.invalidateQueries({ queryKey: ['hooks'] });
    },
    meta: { successMessage },
  });
}

export function useSaveScript() {
  return useScriptMutation(async (input: { id?: string; name: string; content: string }) => {
    // Правка под тем же именем — PUT в тот же файл. Новое имя — и при создании,
    // и при переименовании в редакторе — POST: сервер заводит новый файл, а
    // занятое имя отклоняет (409); старый файл остаётся на месте, как и обещает
    // подсказка под полем имени. Раньше набранное имя при правке молча терялось.
    if (input.id && input.id === input.name) {
      const { data } = await apiClient.put<ScriptWriteResult>(
        `/scripts/${encodeScriptId(input.id)}`,
        { content: input.content },
      );
      return data;
    }
    const { data } = await apiClient.post<ScriptWriteResult>('/scripts', {
      name: input.name,
      content: input.content,
    });
    return data;
  }, 'toasts.saved');
}

export function useDeleteScript() {
  return useScriptMutation(async (id: string) => {
    const { data } = await apiClient.delete<ScriptWriteResult>(`/scripts/${encodeScriptId(id)}`);
    return data;
  }, 'toasts.deleted');
}
