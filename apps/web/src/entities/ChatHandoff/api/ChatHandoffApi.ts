import { useMutation } from '@tanstack/react-query';
import type { HandoffProposal, HandoffStarted } from '@agentdeck/contracts/chat-handoff';
import { apiClient } from '@shared/api/client';

/**
 * Продолжение работы в чистой сессии — сторона клиента.
 *
 * Разговор заводит СЕРВЕР одним запросом, потому что он же продолжает цепочку
 * сам, когда вкладка закрыта: два разных пути к одному и тому же результату
 * разошлись бы на первой правке. Клиенту остаётся открыть вкладку на пути из
 * ответа — ровно как у разделения задач.
 *
 * Тумблер автопродолжения тоже серверный: решение продолжать принимается в
 * момент, когда браузера может не быть вовсе.
 */

export interface StartHandoffBody {
  /** Каталог закрываемого разговора: продолжение идёт в нём же. */
  projectPath: string;
  /** Ключи закрываемого разговора — от них наследуется цепочка. */
  chatId?: string;
  sessionId?: string;
  proposal: HandoffProposal;
  /** Запускать прогон сразу или только завести чат с готовым заданием. */
  startRun: boolean;
  allowEdits: boolean;
  model?: string;
  effort?: string;
}

export function useStartHandoff() {
  return useMutation({
    meta: { silentError: true },
    mutationFn: async (body: StartHandoffBody) => {
      const { data } = await apiClient.post<HandoffStarted>('/chat/handoff', body);
      return data;
    },
  });
}
