import { useQueryClient, useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import type { ProjectFileSaveResult, ProjectFileContent } from '@agentdeck/contracts';
import { ROOT_KEY } from './ProjectFileApi.constants';

/**
 * Запись правки человека.
 *
 * Ответ сервера кладём в кэш файла сразу: в нём новое время записи, и без него
 * следующее сохранение ушло бы со старым `mtimeMs` — то есть отбилось бы как
 * несвежее сразу после успешной записи. Сводку правок при этом сбрасываем:
 * ручная правка меняет и дифф.
 */
export function useSaveProjectFile(path: string | undefined, chatId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: { file: string; content: string; mtimeMs: number }) => {
      const { data } = await apiClient.put<ProjectFileSaveResult>('/project-files/content', {
        path,
        ...input,
      });
      return { ...data, file: input.file, content: input.content };
    },
    onSuccess: (result) => {
      queryClient.setQueryData<ProjectFileContent>(
        [ROOT_KEY, 'content', path ?? '', result.file, chatId ?? ''],
        (current) =>
          current
            ? {
                ...current,
                content: result.content,
                mtimeMs: result.mtimeMs,
                sizeBytes: result.sizeBytes,
              }
            : current,
      );
      void queryClient.invalidateQueries({ queryKey: [ROOT_KEY, 'changes'] });
    },
    meta: { successMessage: 'toasts.saved' },
  });
}
