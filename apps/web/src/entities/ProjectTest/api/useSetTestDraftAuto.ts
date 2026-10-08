import { useQueryClient, useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import type { ProjectTestsView } from '@agentdeck/contracts';
import { testKeys } from './keys';

/**
 * Галочка «принимать сразу» — одно положение на проект.
 *
 * Стоит и в форме запуска, и в окне приёмки намеренно: первые предложения
 * человек смотрит глазами, а дальше включает приём, не дожидаясь следующего
 * прогона. Двух разных настроек для одного решения быть не должно.
 */
export function useSetTestDraftAuto(path: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (enabled: boolean) => {
      const { data } = await apiClient.post<{ autoAccept: boolean; view: ProjectTestsView }>(
        '/project-tests/draft/auto',
        { path, enabled },
      );
      return data;
    },
    onSuccess: (data) => {
      client.setQueryData(testKeys.view(path), data.view);
    },
  });
}
