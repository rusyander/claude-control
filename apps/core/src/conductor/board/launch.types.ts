import type { BoardEntry } from '@agentdeck/contracts/core/board';
import type { BoardSection } from '@agentdeck/contracts/core/config';
import type { ProofDeps } from './proof.ts';
import type { TaskReader } from './read.ts';
import type { BoardStore } from './store.types.ts';

/** Исход старта записи: задача есть (новая или найденная повтором) — или отказ с причиной. */
export type StartOutcome = { taskId: string } | { refused: string };

/** Суд маршрута головы: окно держит — `hold` с причиной; идёт — с подсказкой при `warn`. */
export type RouteVerdict = { hold: string } | { go: true; hint?: string };

export interface LaunchDeps {
  store: BoardStore;
  tasks: TaskReader;
  section(): { value: BoardSection } | { unknown: string };
  proof: ProofDeps;
  route(entry: BoardEntry): RouteVerdict;
  /** Тот же путь, что у человека: оценка (поля) или ревью по ссылке, ключ повтора — `entry.cmdId`. */
  start(entry: BoardEntry): Promise<StartOutcome>;
  /**
   * Своя дорога записи «ответить ревьюерам» (этап 12, Z7, P164): мой MR из входящих открывается
   * `openAnswerTaskFromMr`, а не ревью по ссылке. Нет — такая запись не стартует (причина названа).
   */
  answerFromMr?(entry: BoardEntry): Promise<StartOutcome>;
  now(): number;
  note(message: string): void;
}

export interface Launcher {
  /** Посмотреть очередь сейчас; идёт такт — ещё один круг после него. */
  tick(): Promise<void>;
  stop(): Promise<void>;
}
