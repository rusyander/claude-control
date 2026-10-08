import type { DirEntry } from './ProjectApi.types';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';

export interface DirListing {
  path: string;
  parent?: string;
  entries: DirEntry[];
}

/**
 * Подкаталоги выбранной папки. Запрос идёт, только когда путь задан.
 *
 * `fileExtensions` добавляет в список ещё и файлы с этими расширениями — так
 * выбирают архив переноса окружения. Без параметра поведение прежнее: только
 * каталоги (выбор папки проекта).
 */
export function useFsList(path: string | undefined, fileExtensions?: string[]) {
  const files = fileExtensions?.join(',');
  return useQuery({
    queryKey: ['fs', 'list', path, files ?? ''],
    queryFn: async () => {
      const { data } = await apiClient.get<DirListing>('/fs/list', { params: { path, files } });
      return data;
    },
    enabled: Boolean(path),
  });
}
