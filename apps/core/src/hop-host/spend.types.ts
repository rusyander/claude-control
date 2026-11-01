import type { HopRegistration, HopSpend } from '@agentdeck/contracts/core/hops';

/** Что учёту нужно о сеансе: метка, маршрут и цена маршрута из регистрации. */
export type SpendSpec = Pick<HopRegistration, 'tag' | 'routeId' | 'price'>;
import type { RouteId } from '@agentdeck/contracts/core/routes';

/**
 * Расход одного ответа модели: вход без кэша, прочитано из кэша, записано в кэш (из него — на
 * час: в прайсе у часовой записи своя ставка), выход.
 */
export interface SpendUsage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
  output: number;
}

/** Строка `<home>/spend/<tag>.json`. */
export interface StoredSpend extends HopSpend {
  routeId: RouteId;
  updatedAt: number;
}

/** `<home>/spend/exhausted.json`: маршруты, исчерпанные ответом 402. */
export interface ExhaustedFile {
  v: 1;
  routes: { routeId: RouteId; exhaustedAt: number }[];
}
