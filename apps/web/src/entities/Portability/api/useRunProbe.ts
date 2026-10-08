import type { ProbeAnswer } from '@agentdeck/contracts/portable-probe';
import { apiClient } from '@shared/api/client';
import { useMutation } from '@tanstack/react-query';

/** Что нужно пробе: цель и уровень. Источник ей не нужен — она про ЦЕЛЬ. */
export interface ProbeRequest {
  target: string;
  scope: 'global' | 'project';
}

export async function postProbe(request: ProbeRequest): Promise<ProbeAnswer> {
  const { data } = await apiClient.post<ProbeAnswer>('/portability/probe', request);
  return data;
}

/**
 * Приёмочная проба (П2.4). Мутация, и не потому что сервер что-то пишет в дом
 * человека — он его не трогает вовсе, — а потому что маршрут ЗАПУСКАЕТ чужой
 * процесс. Запросом за ресурсом это означало бы, что открытая вкладка сама
 * решает, когда поднять целевой CLI, и повторяет это при каждом обновлении.
 *
 * Ответ никуда не складывается: отчёт пробы — измерение МОМЕНТА, и показанный
 * из кэша на следующий день он говорил бы о переносе, которого уже нет.
 */
export function useRunProbe() {
  return useMutation({ meta: { silentError: true }, mutationFn: postProbe });
}
