import type { ModelPricing, PricingEntry } from '@agentdeck/contracts';
import type { UsageLike } from '../cost.ts';

/**
 * Таблица, по которой маршрут с деньгами считает (P127): прайс (`entries`, пусто — встроенный
 * снимок пакета цен) и цены, объявленные шлюзом для своих моделей (точный id → цена).
 */
export interface PriceTable {
  entries?: PricingEntry[];
  declared?: Record<string, ModelPricing>;
}

/**
 * Цена одного хода. Деньги — только у маршрута с деньгами и известной ценой версии модели;
 * подписка — единицы окна (вход = 1), денег нет; локальная, без цены и неизвестная цена —
 * только токены (P127: выдуманная сумма хуже пустой).
 */
export type TurnPrice =
  | { unit: 'money'; usd: number; version: string }
  | { unit: 'window'; units: number }
  | { unit: 'tokens'; tokens: number; reason: TokensOnlyReason };

export type TokensOnlyReason = 'gpu-time' | 'no-price' | 'unknown-price' | 'unknown-model';

/** Ход для пересчёта расхода: маршрут, модель, числа и момент хода (цена — на тот момент). */
export interface PricedTurn {
  routeId: string;
  model: string;
  usage: UsageLike;
  at: number;
}

/** Итог расхода по ходам: деньги, единицы окна и токены без цены — раздельно, не в одну сумму. */
export interface SpendTotals {
  usd: number;
  windowUnits: number;
  unpricedTokens: number;
  /** Версия прайса → сколько ходов ею оценено (видно, какой ценой посчитан расход). */
  versions: Record<string, number>;
  turns: number;
}
