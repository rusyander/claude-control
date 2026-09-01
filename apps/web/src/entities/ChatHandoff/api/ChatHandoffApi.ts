import { useMutation } from '@tanstack/react-query';
import type { HandoffProposal, HandoffStarted } from '@claude-control/contracts/chat-handoff';
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
    mutationFn: async (body: StartHandoffBody) => {
      const { data } = await apiClient.post<HandoffStarted>('/chat/handoff', body);
      return data;
    },
  });
}

/** Состояние цепочки разговора: тумблер, номер шага и потолок. */
export interface HandoffState {
  auto: boolean;
  depth: number;
  maxChain: number;
}

export async function fetchHandoffState(keys: {
  chatId?: string;
  sessionId?: string;
}): Promise<HandoffState> {
  const { data } = await apiClient.get<HandoffState>('/chat/handoff/state', { params: keys });
  return data;
}

/** Переключить автопродолжение этого разговора. */
export async function setHandoffAuto(
  keys: { chatId?: string; sessionId?: string },
  enabled: boolean,
): Promise<{ auto: boolean; depth: number }> {
  const { data } = await apiClient.post<{ auto: boolean; depth: number }>('/chat/handoff/auto', {
    ...keys,
    enabled,
  });
  return data;
}

/**
 * Текст просьбы «закрой этап и подготовь продолжение», который уходит агенту по
 * кнопке. Живёт на сервере вместе с описанием формата блока: вторая копия
 * инструкции в клиенте разошлась бы с первой на ближайшей же правке.
 */
export async function fetchHandoffRequestPrompt(): Promise<string> {
  const { data } = await apiClient.get<{ prompt: string }>('/chat/handoff/request');
  return data.prompt;
}
