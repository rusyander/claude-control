import type { Fact } from '@agentdeck/contracts/core/facts';

/** Стенд задачи (04:75-77): дев-серверы, порты, данные; адрес здоровья под наблюдением. */

export interface StandWatchOptions {
  health: string;
  intervalMs?: number;
  /** Чтение здоровья: код ответа; по умолчанию HTTP GET через платформу (класс `stand.health`). */
  read?: (url: string) => Promise<Fact<number>>;
  /** Личность процесса стенда (pid + старт); сменилась — стенд перезапущен. */
  identity?: () => Promise<Fact<string>>;
  setTimer?: (fn: () => void, ms: number) => { cancel(): void };
}

export interface StandState {
  /** Растёт на каждом переходе здоров ↔ нет и смене личности: прогон сравнивает до и после. */
  epoch: number;
  /** `null` — ещё не читалось. */
  healthy: boolean | null;
  lastReason: string;
}

export interface StandWatch {
  tick(): Promise<StandState>;
  state(): StandState;
  start(): void;
  stop(): void;
}

/**
 * Вход C: эпоха стенда задачи (с единицей — стенд единицы, если он свой); `null` — у задачи
 * нет стенда (прогон без стенда). Читается свежим чтением здоровья, поэтому асинхронно.
 */
export type StandEpoch = (taskId: string, unit?: string) => Promise<number | null>;
