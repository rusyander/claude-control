import type { ContinuationNumbers, ForcedFresh } from '@agentdeck/contracts/core/economy';
import type { SessionRecord } from '../journal/reduce/reduce.types.ts';
import type { CacheRates } from './cost.ts';

export interface ContinuationSession {
  sessionId: string;
  /** id шага сценария, на котором сессия шла (`state.steps[stepId].stepDefId`). */
  stepDefId: string;
  state: SessionRecord['state'];
  adapter: string;
  route: SessionRecord['route'];
  startedSeq: number;
}

/**
 * Числа сессии и маршрута для правила 03:150-155. Нет (`undefined`) — расход сессии ещё не
 * измерен: все числа нули, продолжение не дороже нового (решение называет это).
 */
export interface ContinuationFacts {
  /** Стена «сейчас», мс. */
  now: number;
  /** Стена последнего хода сессии (`at` её последней строки `turn.usage`); `null` — ходов нет. */
  lastTurnAt: number | null;
  /** Размер запроса последнего хода (вход + чтение + запись кэша). */
  contextTokens: number;
  /** Срок кэша сессии (по доле часовой записи её ходов, иначе факт маршрута); `null` — без кэша. */
  cacheTtlMs: number | null;
  /** Окно модели (факт `context` маршрута); `null` — неизвестно: правило 60 % не судит. */
  windowTokens: number | null;
  /** Базовый контекст нового сеанса (G9) и вводная шага. */
  baseTokens: number;
  briefTokens: number;
  /** Ходов впереди и ходов ориентации нового сеанса — выученные (`economy/learned`). */
  expectedTurns: number;
  orientationTurns: number;
  /**
   * Цена хода ориентации в единицах цены входа (выученная: `ECON_PRIOR.turnCostRatio` × база,
   * пока журналы не дали своей). Нет — чтение базы и вводной по цене кэша.
   */
  turnCost?: number;
  /** Доли цены маршрута × модели (`ratesOf` из `economy/price`); нет — относительные `RELATIVE_RATES`. */
  rates?: CacheRates;
}

export interface ContinuationInput {
  stepDefId: string;
  /** Куда идёт новый ход — исход `decideTier`. */
  next: { adapter: string; route: SessionRecord['route'] };
  sessions: readonly ContinuationSession[];
  /** Состояние единицы шага: `done`/`conditional`/`closed` — новый сеанс (P15, F07). */
  unitState?: string | null;
  /** Транскрипт живой сессии на месте; `false` — продолжать нечем (P15). */
  transcriptPresent?: boolean;
  facts?: ContinuationFacts;
}

export type FreshReason = 'no-live-session' | 'route-changed' | 'cheaper-fresh' | ForcedFresh;

export type ContinuationDecision =
  | {
      /** Не `continue`: это id CLI реестра, P108 ловит его целой строкой вне переходника. */
      mode: 'same-session';
      sessionId: string;
      reasons: string[];
      numbers: ContinuationNumbers;
      basis: 'modelled';
    }
  | {
      mode: 'fresh';
      reason: FreshReason;
      reasons: string[];
      numbers: ContinuationNumbers;
      basis: 'modelled';
    };
