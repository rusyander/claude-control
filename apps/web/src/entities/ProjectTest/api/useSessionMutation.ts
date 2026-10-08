import type { ProjectTestManualSession } from '@agentdeck/contracts';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { testKeys } from './keys';
import { isConflict } from '../../../shared/api/isConflict';

/** Общая часть команд ручного прогона: ответ — сессия (или её отсутствие). */
export function useSessionMutation<TVariables>(
  path: string | undefined,
  send: (variables: TVariables) => Promise<ProjectTestManualSession | null>,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: send,
    onSuccess: (session) => {
      client.setQueryData(testKeys.manual(path), session);
      // Статусы кейсов и история меняются тем же результатом — обе ветки устарели.
      void client.invalidateQueries({ queryKey: testKeys.view(path) });
      void client.invalidateQueries({ queryKey: testKeys.runs(path) });
      void client.invalidateQueries({ queryKey: testKeys.report(path) });
      // Отметки «нестабилен» и история кейса тоже из истории прогонов, но
      // подписаны последним прогоном АГЕНТА — ручной проход её не меняет.
      void client.invalidateQueries({ queryKey: testKeys.flaky(path) });
      void client.invalidateQueries({ queryKey: testKeys.caseHistory(path) });
    },
    // 409 — проход уже идёт (начат в другом окне или с телефона): перечитать
    // его, чтобы экран продолжил идущий, а не предлагал начать второй.
    onError: (error) => {
      if (!isConflict(error)) return;
      void client.invalidateQueries({ queryKey: testKeys.manual(path) });
      void client.invalidateQueries({ queryKey: testKeys.view(path) });
    },
  });
}
