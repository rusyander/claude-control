import type { QueryClient } from '@tanstack/react-query';
import type { CascadeRulePatch, CascadeRuleView } from '@agentdeck/contracts/model-cascade';
import { apiClient } from '@shared/api/client';
import { cascadeKey } from './cascadeKey';

/**
 * Запись правила проекта. Меняется только названный тумблер: подбор модели
 * (`enabled`) или «Ревью после работы» (`reviewAfterWork`, R3(d) 26.10) — один не
 * трогает другой, поэтому в тело уходит ровно то поле, что передали.
 */
export function setCascadeRuleOptions(queryClient: QueryClient, path: string | undefined) {
  return {
    mutationFn: async (patch: Omit<CascadeRulePatch, 'path'>) => {
      const { data } = await apiClient.put<CascadeRuleView>('/chat/cascade', {
        path,
        ...patch,
      });
      return data;
    },
    // Ответ и есть новое состояние: лишний запрос следом здесь не нужен, а вот
    // соседние вкладки того же проекта должны увидеть смену — их ключ другой,
    // поэтому гасим всё семейство.
    onSuccess: (data: CascadeRuleView) => {
      queryClient.setQueryData(cascadeKey(path), data);
      void queryClient.invalidateQueries({ queryKey: ['chat-cascade'] });
    },
  };
}
