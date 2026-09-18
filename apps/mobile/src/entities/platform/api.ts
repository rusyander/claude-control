import { useQuery } from '@tanstack/react-query';
import type { PlatformRunPlan, PlatformsInfo } from '@agentdeck/contracts';
import { api } from '../../shared/api/client';

/**
 * Контур на телефоне — ТОЛЬКО чтение (Т12).
 *
 * Читать полезно: контур это единственный канал, по которому корпоративные
 * модели доходят до панели, а бюджет ключа кончается молча — 402 приходит
 * посреди рабочего дня, и узнать об этом, не подходя к машине, стоит.
 *
 * Править нельзя, и это не лень. Ключ вводят в панели, на своей машине, и
 * показывать его здесь незачем даже маской; включение контура меняет то, куда
 * уходит трафик ДЕВЯТИ CLI, а телефон человек достаёт в дороге. Поэтому ни
 * одной мутации: маршрутов записи телефон не зовёт вовсе.
 */
export { runPlanConsumer, runPlanView, type RunPlanLine, type RunPlanView } from './run-plan';
export { budgetPercent, platformProblem, platformTone, type PlatformProblem } from './state';

/** Контуры панели с бюджетом и итогом последней пробы. */
export function usePlatforms() {
  return useQuery({
    queryKey: ['platforms'],
    queryFn: () => api.get<PlatformsInfo>('/platforms'),
    // Расход дописывается пачкой на стороне панели, и минутная свежесть здесь
    // честнее, чем ежесекундный опрос из кармана.
    staleTime: 60_000,
    retry: false,
  });
}

/**
 * Чем пойдёт прогон чата: модель контура, усилие, снятые слои, отказ. Тот же
 * адрес, что спрашивает шапка чата панели; решение принимается по состоянию
 * панели, без сети дальше неё — поэтому свежесть короткая.
 */
export function usePlatformRunPlan(consumer = 'chat') {
  return useQuery({
    queryKey: ['platform-run-plan', consumer],
    queryFn: () => api.get<PlatformRunPlan>(`/platform-run-plan/${encodeURIComponent(consumer)}`),
    staleTime: 15_000,
    retry: false,
  });
}
