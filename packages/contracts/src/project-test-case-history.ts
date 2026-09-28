import type {
  ProjectTestActor,
  ProjectTestFailure,
  ProjectTestRunMode,
  ProjectTestStatus,
} from './project-tests';

/**
 * История результатов ОДНОГО кейса по прогонам — как «Results» у кейса в
 * TestRail: когда гоняли, чем кончилось, в каком прогоне и что сломалось.
 *
 * Отдельным модулем от `project-tests.ts`: это чтение поверх записей прогонов,
 * и ему не место среди форматов файлов, которые правят обе стороны.
 */

/** Одна точка истории: кейс в одном прогоне. */
export interface ProjectTestCaseResultEntry {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  mode: ProjectTestRunMode;
  actor: ProjectTestActor;
  release?: string;
  environmentId?: string;
  branch?: string;
  commit?: string;
  /**
   * Исход кейса в этом прогоне. У кейса с параметрами проходов несколько —
   * здесь худший из них: зелёная тёмная тема не отменяет красную светлую.
   */
  status: ProjectTestStatus;
  /** Сколько проходов кейса было в прогоне (комбинации параметров). */
  points: number;
  /** Заметка исполнителя у решающего прохода — первой строкой причина. */
  note?: string;
  /** Разбор провала решающего прохода: шаг, ожидание, что вышло. */
  failure?: ProjectTestFailure;
  /** Заведённые по этому результату дефекты. */
  defects?: string[];
  durationMs?: number;
}

/** Нестабильность кейса по последним прогонам. */
export interface ProjectTestFlakyVerdict {
  isFlaky: boolean;
  /** Сколько раз результат переключался между «пройден» и «провален». */
  flips: number;
  /** Сколько прогонов с решающим исходом (пройден/провален) попало в окно. */
  runs: number;
}

export interface ProjectTestCaseHistory {
  groupId: string;
  caseId: string;
  /** От новых к старым. */
  entries: ProjectTestCaseResultEntry[];
  flaky: ProjectTestFlakyVerdict;
}

/** Отметка «нестабилен» для строки библиотеки. */
export interface ProjectTestFlakyMark extends ProjectTestFlakyVerdict {
  groupId: string;
  caseId: string;
}

export interface ProjectTestFlakyMarks {
  /** Правило, по которому отмечено, — его и называет подсказка. */
  window: number;
  minFlips: number;
  cases: ProjectTestFlakyMark[];
}

/**
 * Правило нестабильности.
 *
 * Берутся последние `FLAKY_WINDOW` прогонов кейса, из них — только решающие
 * исходы (пропуск и блокировка ничего не говорят о самом тесте). Нестабилен
 * кейс, у которого «пройден ↔ провален» сменились хотя бы `FLAKY_MIN_FLIPS`
 * раз: одна смена — это поломка или починка, две и больше при одном коде —
 * тест, которому нельзя верить.
 */
export const FLAKY_WINDOW = 10;
export const FLAKY_MIN_FLIPS = 2;
