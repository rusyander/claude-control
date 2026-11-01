import type { WindowVerdict } from '@agentdeck/contracts/core/economy';
import type { CacheRates } from '../cost.ts';

export interface KeepWarmInput {
  now: number;
  session: {
    /** Сессия стоит не по воле модели (ждёт человека, паузу, очередь) — её ход кэш не держит. */
    parked: boolean;
    /** Стена последнего хода; `null` — ходов не было, греть нечего. */
    lastTurnAt: number | null;
    contextTokens: number;
    /** Срок кэша сессии (`sessionCacheFacts`); `null` — без кэша. */
    cacheTtlMs: number | null;
  };
  /** Переходник объявил продолжение сеанса (`caps.resume`): пинг — один ход в эту же сессию. */
  adapterResume: boolean;
  /** Вердикт окна маршрута; `null` — фактов нет (неизвестно не значит открыто). */
  window: WindowVerdict | null;
  /** Пинги этого ожидания (с последнего хода сессии). */
  pings: { count: number; lastPingAt: number | null };
  /** Доли цены маршрута × модели (`ratesOf` из `economy/price`); нет — относительные `RELATIVE_RATES`. */
  rates?: CacheRates;
}

export type KeepWarmSkip =
  | 'not-parked'
  | 'no-resume'
  | 'route-held'
  | 'route-not-open'
  | 'no-turns'
  | 'no-cache'
  | 'ttl-short'
  | 'cold'
  | 'not-yet'
  | 'cap'
  | 'not-cheaper';

export type KeepWarmDecision =
  | { kind: 'ping'; word: string; reasons: string[]; numbers: Record<string, number> }
  | { kind: 'skip'; reason: KeepWarmSkip; reasons: string[]; numbers: Record<string, number> };
