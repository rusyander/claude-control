import { useMutation } from '@tanstack/react-query';
import type { PanelPendingDecision } from '@agentdeck/contracts/panel-agent';
import { apiClient } from '@shared/api/client';

/**
 * Решение по карточке. Ответ — только `{ok:true}`: итог (выполнено, ошибка
 * маршрута) приходит кадром `agent-decided`, поэтому карточку снимает кадр, а
 * не этот ответ.
 */
export function useDecidePanelAction() {
  return useMutation({
    // Причину отказа карточка показывает сама, под кнопками: тост с сырым
    // текстом сервера рядом повторял бы её (и по-английски, у 409).
    meta: { silentError: true },
    mutationFn: async ({ id, decision }: { id: string } & PanelPendingDecision) => {
      const body: PanelPendingDecision = { decision };
      await apiClient.post(`/agent/pending/${encodeURIComponent(id)}`, body);
    },
  });
}
