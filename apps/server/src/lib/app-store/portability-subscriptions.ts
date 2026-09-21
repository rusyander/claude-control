import type { EnvSubscription } from '@agentdeck/contracts/portable-subscribe';
import type { AppState } from './app-store.types.ts';

/**
 * Подписки целей на канон панели (П5.1).
 *
 * В состоянии панели, а не в настройках, по той же причине, что след переноса и
 * оттиск отчёта верности: подписка называет пути файлов ЭТОЙ машины и хранит
 * хеши того, что панель в них оставила. На другой машине те же строки означали
 * бы чужие файлы, а перенесённые настройки объявили бы спроецированным то,
 * чего там никогда не было.
 *
 * Отписка стирает СЛОИ, а не запись: в записи лежит память о том, что уже
 * спроецировано, и выбросить её значило бы при следующей подписке объявить
 * новым каждый файл, который панель уже писала, — то есть предложить человеку
 * переписать цель с нуля вместо того, чтобы продолжить с места.
 */

export function getPortabilitySubscriptions(state: AppState): Record<string, EnvSubscription> {
  return structuredClone(state.portabilitySubscriptions ?? {});
}

export function getPortabilitySubscription(
  state: AppState,
  key: string,
): EnvSubscription | undefined {
  const stored = state.portabilitySubscriptions?.[key];
  return stored ? structuredClone(stored) : undefined;
}

export function savePortabilitySubscription(
  state: AppState,
  key: string,
  subscription: EnvSubscription,
): void {
  state.portabilitySubscriptions ??= {};
  state.portabilitySubscriptions[key] = subscription;
}

/**
 * Забыть подписку целиком — вместе с памятью о спроецированном.
 *
 * У цели при этом не удаляется НИЧЕГО: подписка никогда не была владельцем её
 * файлов, она была обещанием их обновлять. Обещание снимается, файлы остаются
 * такими, какими их оставила последняя пересборка.
 */
export function forgetPortabilitySubscription(state: AppState, key: string): void {
  if (!state.portabilitySubscriptions) return;
  delete state.portabilitySubscriptions[key];
}
