import { useQueryClient, useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import type { ProjectTestDraft } from '@agentdeck/contracts';
import { testKeys } from './keys';

/**
 * «Сделать кейс» из разговора: сервер собирает черновик из реплик человека и
 * вызовов инструментов. Библиотеку он не меняет — черновик ждёт приёмки в
 * разделе «Тесты», как предложения генерации.
 */
export function useDraftFromChat() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { path: string; chatId: string; chatTitle?: string }) => {
      const { data } = await apiClient.post<{ runId: string; draft: ProjectTestDraft }>(
        '/project-tests/draft/from-chat',
        input,
      );
      return data;
    },
    // Отказ называет меню чата своим тостом — общий дал бы второй.
    meta: { silentError: true },
    onSuccess: (_data, input) => {
      // Плашка «предложения ждут» едет с видом раздела — он должен перечитаться.
      void client.invalidateQueries({ queryKey: testKeys.view(input.path) });
    },
  });
}
