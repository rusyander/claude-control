import type { FirstPassSample, LearnedKey } from '@agentdeck/contracts/core/economy';

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
  /**
   * Проба первого прохода (этап 11, P140): только первая попытка шага сценария в единице; `null`
   * — повтор, шаг без исхода или вклад кэша v2 (проб тогда не снимали).
   */
  firstPass: FirstPassSample | null;
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
  /**
   * Длительности законченных сеансов задачи, мс активного времени (`session.started` → переход
   * `exited` из живого состояния, минус сон машины): сколько сеанс держит место распределителя.
   * Сеансы чата (вне счёта мест), потерянные и не стартовавшие не входят. Нет поля — вклад кэша,
   * записанный до него: `readLearned` пересобирает такой вклад из журнала.
   */
  sessionMs?: number[];
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
  /**
   * Медиана длительности законченного сеанса по всем журналам (`JournalSamples.sessionMs`) и
   * число образцов; образцов нет — `medianMs: null` (ожидание места не оценивается, не выдумывается).
   * Нет поля — таблица собрана без истории сеансов (тестовая таблица оценки).
   */
  sessions?: { medianMs: number | null; samples: number };
  /**
   * Пробы первого прохода по ключу (`keyOf`, роль входит), по времени, все с последнего сброса —
   * подъём судит последние `promotion.window` из них (`promotionOf`; окно не больше
   * `FIRST_PASS_RING_MAX`).
   */
  firstPass?: Record<string, FirstPassSample[]>;
  /** Сбросы ключей человеком (`learned-reset`): пробы до `at` не считаются. */
  resets?: Record<string, LearnedReset>;
}

/** Сброс ключа обучения командой человека: подъём снят, счёт проб начинается заново. */
export interface LearnedReset {
  at: number;
  cmdId: string;
}

/**
 * Кэш `<home>/cache/learned.json`: вклад каждого законченного журнала, пересобирается с нуля.
 * Версия 2 — вклад несёт `toolMs`; кэш версии 1 его не знает и пересобирается из журналов.
 * Версия 3 (этап 11) — ключ несёт роль, шаг — пробу первого прохода, кэш — сбросы ключей
 * человеком (их нет в журналах задач: сброс — команда ядра, не строка задачи). Кэш v2 поднимается
 * (`upcastLearnedCache`): роль — роль вида шага, пробы нет, строки и числа те же.
 */
export interface LearnedCache {
  version: 3;
  journals: Record<string, JournalSamples>;
  resets: Record<string, LearnedReset>;
}
