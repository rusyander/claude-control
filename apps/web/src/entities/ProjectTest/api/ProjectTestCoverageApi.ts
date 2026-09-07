import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProjectTestCoverage } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { testKeys } from './keys';

/**
 * Покрытие требований и судьба заведённых дефектов.
 *
 * Оба вопроса требуют чужой системы, и оба обязаны отвечать даже когда её нет:
 * матрица собирается по ссылкам кейсов, а отказ Jira приезжает в `warning`
 * рядом с данными. Поэтому здесь нет ни одной обработки ошибки «показать
 * пустой экран» — сервер всегда отдаёт то, что смог собрать.
 */

/** Кейс, который стоит перепроверить: провален, а дефект уже закрыт. */
export interface DefectRecheckItem {
  groupId: string;
  caseId: string;
  title: string;
  url: string;
  key?: string;
}

export interface DefectRefreshResult {
  checked: number;
  closed: number;
  recheck: DefectRecheckItem[];
  skipped: string[];
}

/**
 * Матрица покрытия. Запрос POST, поэтому здесь `useQuery` с телом — это всё
 * равно чтение: сервер ничего не меняет, а JQL просто не помещается в адрес.
 */
export function useTestCoverage(path: string | undefined, jql: string, isEnabled = true) {
  return useQuery({
    queryKey: testKeys.coverage(path, jql),
    queryFn: async () => {
      const { data } = await apiClient.post<ProjectTestCoverage>('/project-tests/coverage', {
        path,
        jql: jql || undefined,
      });
      return data;
    },
    enabled: Boolean(path) && isEnabled,
  });
}

/**
 * Спросить трекеры о заведённых дефектах.
 *
 * Ответ меняет файлы кейсов (в них ложится статус дефекта), поэтому библиотека
 * и матрица после него перечитываются: иначе закрытый дефект остался бы виден
 * открытым до следующего обновления страницы.
 */
export function useRefreshDefects(path: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data } = await apiClient.post<DefectRefreshResult>('/project-tests/defects/refresh', {
        path,
      });
      return data;
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: testKeys.view(path) });
      void client.invalidateQueries({ queryKey: testKeys.coverageAll(path) });
    },
  });
}
