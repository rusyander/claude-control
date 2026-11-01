import type { LearnedKey } from '@agentdeck/contracts/core/economy';

/** Один шаг прошлой задачи — образец выученного (03 §Economy, порт смысла `lowered-journal`). */
export interface StepSample {
  key: LearnedKey;
  /** Токены бюджета шага (G10) по всем его сеансам, подагенты включены. */
  tokens: number;
  /** Активное время шага, мс: стена минус сон машины (`clock.jump`). */
  activeMs: number;
  /** Ходов модели (без остатков и подагентов). */
  turns: number;
  outcome: 'done' | 'failed' | 'skipped';
  /** Модель шага была понижена уровнем `lower-if-mechanical`. */
  lowered: boolean;
}

/** Задача целиком — образец оценки до запуска. */
export interface TaskSample {
  taskId: string;
  projects: string[];
  scenarioId: string | null;
  tokens: number;
  activeMs: number;
  outcome: 'done' | 'cancelled' | 'failed';
}

/**
 * Вклад одного законченного журнала: шаги без правок человека, сама задача и длительности
 * вызовов инструментов по классу действия (`tool.event.ms`, этап 8 — порог тишины сессии).
 */
export interface JournalSamples {
  steps: StepSample[];
  task: TaskSample;
  toolMs: Record<string, number[]>;
}

/** Меньше образцов класса — p95 вызова не выучен: порог тишины берёт значение спеки (F9). */
export const TOOL_P95_MIN_SAMPLES = 20;

export interface LearnedStats {
  runs: number;
  failures: number;
  /** Падения на пониженной модели: этот ключ больше не понижается (03:144). */
  loweredFailures: number;
  p90Tokens: number;
  p90Minutes: number;
  medianTurns: number;
}

/** Выученное по ключам и задачам; `skipped` — нечитаемые журналы, названы, не молча. */
export interface LearnedTable {
  byKey: Record<string, LearnedStats>;
  /** По виду шага проекта, без переходника и модели: бюджет шага до первого прогона на модели. */
  byKind: Record<string, LearnedStats>;
  tasks: TaskSample[];
  skipped: number;
  /**
   * p95 длительности вызова инструмента, мс, по классу действия (`tool.event.effectClass`) — только
   * классы с не меньше чем `TOOL_P95_MIN_SAMPLES` образцами. Нет поля — таблица собрана без
   * истории вызовов (тестовая таблица оценки); пустой объект — история есть, класса не выучено.
   */
  toolMsP95?: Record<string, number>;
}

/**
 * Кэш `<home>/cache/learned.json`: вклад каждого законченного журнала, пересобирается с нуля.
 * Версия 2 — вклад несёт `toolMs`; кэш версии 1 его не знает и пересобирается из журналов.
 */
export interface LearnedCache {
  version: 2;
  journals: Record<string, JournalSamples>;
}
