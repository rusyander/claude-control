import { useQuery } from '@tanstack/react-query';
import { testKeys } from './keys';
import { apiClient } from '@shared/api/client';
import type { ProjectTestHistoryEntry } from '@agentdeck/contracts';

/**
 * История файла группы из git: кто и когда правил кейсы.
 *
 * Своего версионирования у раздела нет намеренно — кейсы лежат в репозитории
 * проекта, и git отвечает на этот вопрос вместе с ревью и откатом. Запрос идёт
 * только когда историю открыли: `git log` на каждый показ библиотеки был бы
 * платой ни за что.
 */
export function useTestHistory(
  path: string | undefined,
  groupId: string | undefined,
  isEnabled = true,
) {
  return useQuery({
    queryKey: testKeys.history(path, groupId),
    queryFn: async () => {
      const { data } = await apiClient.get<{ entries: ProjectTestHistoryEntry[] }>(
        '/project-tests/history',
        { params: { path, groupId } },
      );
      return data.entries;
    },
    enabled: Boolean(path) && Boolean(groupId) && isEnabled,
  });
}
