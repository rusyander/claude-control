import { useQuery } from '@tanstack/react-query';
import type { ProjectTestLintReport } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { testKeys } from './keys';

/**
 * Здоровье набора: замечания линтера, дубликаты и предложение таксономии.
 *
 * Оба запроса — чтение и только чтение. Правит библиотеку человек, обычным
 * массовым действием: у линтера в замечании названа кнопка, у таксономии —
 * переносы. Второй ветки правки, которая шла бы мимо привычного bulk, в панели
 * нет намеренно.
 *
 * Считается быстро, но не бесплатно — спрашиваем только когда карточку открыли,
 * а не в каждом опросе вида раздела.
 */

export function useTestLint(path: string | undefined, isEnabled = true) {
  return useQuery({
    queryKey: testKeys.lint(path),
    queryFn: async () => {
      const { data } = await apiClient.get<ProjectTestLintReport>('/project-tests/lint', {
        params: { path },
      });
      return data;
    },
    enabled: Boolean(path) && isEnabled,
  });
}
