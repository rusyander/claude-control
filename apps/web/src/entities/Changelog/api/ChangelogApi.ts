import { useQuery } from '@tanstack/react-query';
import type { ChangelogResponse } from '@agentdeck/contracts/changelog';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

/**
 * Лента «Что нового»: описания из репозитория панели и факты из git. Читающий
 * запрос без побочных эффектов; новый коммит виден после возврата в окно или
 * переоткрытия вкладки — сервер перечитывает git только при смене HEAD.
 */
async function fetchChangelog(): Promise<ChangelogResponse> {
  const { data } = await apiClient.get<ChangelogResponse>('/changelog');
  return data;
}

export function useChangelog() {
  return useQuery({ queryKey: queryKeys.changelog, queryFn: fetchChangelog });
}
