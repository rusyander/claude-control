import { useQuery } from '@tanstack/react-query';
import type { ProjectTestManualSession } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { testKeys } from './keys';

/**
 * Ручной прогон: человек проходит кейсы сам, панель записывает.
 *
 * Сессия живёт на сервере, а не в памяти вкладки: закрытая вкладка, F5 и
 * переход на телефон не должны терять уже отмеченные проходы. Поэтому каждый
 * результат уходит запросом сразу, а ответом приходит вся сессия целиком —
 * восстанавливать её из локального состояния было бы нечем.
 */

export function useManualSession(path: string | undefined, isEnabled = true) {
  return useQuery({
    queryKey: testKeys.manual(path),
    queryFn: async () => {
      const { data } = await apiClient.get<{ session?: ProjectTestManualSession }>(
        '/project-tests/manual',
        { params: { path } },
      );
      return data.session ?? null;
    },
    enabled: Boolean(path) && isEnabled,
  });
}
