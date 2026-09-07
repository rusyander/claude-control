import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { Analytics, RunningAgent } from '@agentdeck/contracts';
import type { LoweredRunRecord } from '@agentdeck/contracts/model-cascade';
import { apiClient } from '@shared/api/client';
import type { AnalyticsPeriod } from '../model/period';
import { periodKey, periodParams } from '../model/period';

async function getAnalytics(period: AnalyticsPeriod): Promise<Analytics> {
  const { data } = await apiClient.get<Analytics>('/analytics', { params: periodParams(period) });
  return data;
}

async function getLive(): Promise<{ runningAgents: RunningAgent[]; at: string }> {
  const { data } = await apiClient.get<{ runningAgents: RunningAgent[]; at: string }>(
    '/analytics/live',
  );
  return data;
}

export function useAnalytics(period: AnalyticsPeriod) {
  return useQuery({
    queryKey: ['analytics', periodKey(period)],
    queryFn: () => getAnalytics(period),
    // Обход транскриптов занимает секунды, поэтому держим результат дольше
    // обычного: перещёлкивание вкладок не должно запускать пересчёт.
    staleTime: 60_000,
    /**
     * Прежний отчёт остаётся на экране, пока считается новый.
     *
     * Без этого смена периода стирала данные до `undefined`, страница
     * схлопывалась до скелета — а она в разы короче — и контейнер прокрутки
     * упирался в новую высоту. Замерено: клик по пресету со скроллом 700 px
     * отбрасывал страницу на 0 и обратно. Заодно исчезали кнопки выгрузки, и
     * ряд фильтров перевёрстывался на каждое переключение.
     */
    placeholderData: keepPreviousData,
  });
}

/**
 * Журнал понижённых прогонов веера: чем их вели и видела ли панель, что прогон
 * выполнил планку сдачи. Сводка приходит с сервера — правило «что считать
 * проверкой» одно и живёт рядом со списком образцов команд.
 */
export interface LoweredRunsView {
  runs: LoweredRunRecord[];
  summary: { total: number; withChecks: number; withoutChecks: number; failed: number };
}

async function getLoweredRuns(): Promise<LoweredRunsView> {
  const { data } = await apiClient.get<LoweredRunsView>('/chat/lowered-runs');
  return data;
}

export function useLoweredRuns() {
  return useQuery({ queryKey: ['chat', 'lowered-runs'], queryFn: getLoweredRuns });
}

/** Живой срез: запущенные процессы. Обновляется часто — он дешёвый. */
export function useLiveAgents() {
  return useQuery({
    queryKey: ['analytics', 'live'],
    queryFn: getLive,
    refetchInterval: 5_000,
    staleTime: 0,
  });
}
