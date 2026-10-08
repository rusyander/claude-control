import { useQuery } from '@tanstack/react-query';
import type { ProjectTestDraft } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { testKeys } from './keys';

/**
 * Черновики генерации: что прогон предложил добавить в библиотеку.
 *
 * Список черновиков строкой едет вместе с общим видом раздела — им и живёт
 * плашка «предложения ждут». А ЦЕЛИКОМ черновик запрашивается только при
 * открытии окна приёмки: он весит столько же, сколько предложенные кейсы, и
 * тащить его в каждый опрос вида было бы платой ни за что.
 */

interface DraftsResponse {
  drafts: ProjectTestDraft[];
  autoAccept: boolean;
}

/** Один черновик целиком — его показывает окно приёмки. */
export function useTestDraft(path: string | undefined, runId: string | undefined) {
  return useQuery({
    queryKey: testKeys.draft(path, runId),
    queryFn: async () => {
      const { data } = await apiClient.get<DraftsResponse>('/project-tests/drafts', {
        params: { path, runId },
      });
      return data.drafts[0];
    },
    enabled: Boolean(path) && Boolean(runId),
  });
}
