import { useMutation } from '@tanstack/react-query';
import type { IntegrationPublishResult } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';

/** Куда публикуется отчёт прогона: страницей Confluence или комментарием в Jira. */
export type PublishTarget = 'confluence' | 'jira';

/**
 * Публикация отчёта наружу.
 *
 * Отдельно от выгрузки файлом: файл человек уносит сам, а публикация пишет в
 * ЧУЖУЮ систему — и делается только по явному нажатию, с адресом созданного в
 * ответе. Куда именно писать, решает привязка проекта, а не эта кнопка.
 */
export function usePublishTestRun(path: string | undefined) {
  return useMutation({
    mutationFn: async (payload: {
      id: string;
      target: PublishTarget;
    }): Promise<IntegrationPublishResult> => {
      const { data } = await apiClient.post<IntegrationPublishResult>(
        '/project-tests/run/publish',
        { path, ...payload },
      );
      return data;
    },
  });
}
