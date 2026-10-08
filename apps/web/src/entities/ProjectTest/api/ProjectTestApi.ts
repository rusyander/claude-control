import { useQuery } from '@tanstack/react-query';
import type { ProjectTestsView } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { TESTS_POLL_MS, testKeys } from './keys';

/**
 * Библиотека тестов проекта: группы, кейсы, общие шаги, окружения, схема,
 * сохранённые фильтры.
 *
 * Все правки возвращают уже пересобранный список — сервер отдаёт его тем же
 * ответом. Поэтому мутации не инвалидируют кэш, а КЛАДУТ в него результат: иначе
 * между записью и перезапросом список моргал бы прежним состоянием, а при
 * идущем прогоне ещё и терял бы только что проставленные галочки.
 *
 * Пока прогон идёт, список перечитывается каждые две секунды: статусы пишет сам
 * агент в файлы на диске, и другого источника прогресса здесь нет — это цена
 * того, что кейсы живут в проекте, а не в памяти панели.
 */

export function useProjectTests(path: string | undefined, isOpen: boolean) {
  return useQuery({
    queryKey: testKeys.view(path),
    queryFn: async () => {
      const { data } = await apiClient.get<ProjectTestsView>('/project-tests', {
        params: { path },
      });
      return data;
    },
    enabled: Boolean(path) && isOpen,
    staleTime: 0,
    // Прогон агента и прогон автотестов панелью идут порознь — ждём любой.
    refetchInterval: (query) =>
      (query.state.data?.run?.status === 'running' ||
        query.state.data?.e2eRun?.status === 'running') &&
      isOpen
        ? TESTS_POLL_MS
        : false,
  });
}
