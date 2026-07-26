import { useMutation } from '@tanstack/react-query';
import type { AssistantRunRequest, AssistantRunResult } from '@claude-control/contracts';
import { apiClient, LONG_TIMEOUTS } from '@shared/api/client';

/**
 * Мультимодельный ассистент (Ф6b): реальный запуск активного провайдера через
 * `POST /api/assistant/run`. Basic-режим (простой текст) для не-claude провайдеров
 * (CLI one-shot / прямой API). Claude сохраняет свой богатый стриминговый чат и
 * этот путь НЕ использует. Ключи наружу не приходят — сервер их не эхоит.
 */
export async function runAssistant(body: AssistantRunRequest): Promise<AssistantRunResult> {
  // Свой таймаут: общие 60 c короче серверного бюджета прогона (180 c), и на
  // холодном старте CLI клиент рвал уже идущий запрос ложной ошибкой таймаута.
  const { data } = await apiClient.post<AssistantRunResult>('/assistant/run', body, {
    timeout: LONG_TIMEOUTS.assistantRun,
  });
  return data;
}

/** Отправить историю сообщений активному провайдеру и получить ответ (basic). */
export function useRunAssistant() {
  return useMutation({ mutationFn: runAssistant });
}
