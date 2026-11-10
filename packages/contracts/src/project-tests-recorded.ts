import type { BrowseGap, BrowseStep } from './core/browse';
import type { ProjectTestStatus } from './project-tests';

/**
 * Записанные проходы по стенду в блоке «Тесты» (этап 12, R3–R4, 08d P179–P180).
 *
 * Удачный проход ядра (шаг `walk`, строки `browse.step`) панель превращает в спек Playwright —
 * чистой функцией строк, без модели и без часов — и в кейс, привязанный к спеку файлом и полным
 * именем теста. Дальше кейс гоняется обычным `tests-cli run` без модели вовсе; модель зовётся
 * только на первом расхождении: «Прогнать все» встаёт на первом упавшем шаге и открывает ровно
 * одну задачу прохода, которая называет этот шаг. Человек решает: дефект продукта или сценарий
 * устарел (тогда кейс перезаписывается из нового прохода).
 */

/** Сколько последних прогонов кейса показывает список записанных проходов. */
export const RECORDED_HISTORY_MAX = 20;

/** Вердикт человека по расхождению: сломан продукт или устарел сам сценарий. */
export const RECORDED_VERDICTS = ['defect', 'stale'] as const;
export type RecordedVerdict = (typeof RECORDED_VERDICTS)[number];

/** Один прогон кейса в полоске истории. */
export interface RecordedRunMark {
  runId: string;
  startedAt: string;
  status: ProjectTestStatus;
}

/** Записанный кейс в списке: откуда собран и как шёл последние прогоны. */
export interface RecordedCaseView {
  groupId: string;
  caseId: string;
  title: string;
  /** Спек от корня проекта (`.agent/tests/recorded/<группа>/<кейс>.recorded.mjs`). */
  file: string;
  /** Полное имя теста — то, что спек объявляет о себе строкой `// recorded-test:`. */
  testName: string;
  /** Задача прохода ядра, из которой собран спек. */
  taskId?: string;
  /** Шагов «не проверено» в кейсе (пробелы прохода и неудавшиеся при записи шаги). */
  unchecked: number;
  status?: ProjectTestStatus;
  /** Последние прогоны, новые первыми, не больше `RECORDED_HISTORY_MAX`. */
  history: RecordedRunMark[];
}

/** Первое расхождение прогона «Прогнать все». */
export interface RecordedMismatch {
  groupId: string;
  caseId: string;
  title: string;
  /** Упавший шаг спека (с единицы) и его подпись; нет — провал вне шага (спек не запустился). */
  step?: { n: number; title: string };
  /** Первая строка провала из записи прогона. */
  message: string;
  /** Задача прохода, открытая по расхождению; нет — ядро отказало (`walkError`). */
  taskId?: string;
  walkError?: string;
  verdict?: RecordedVerdict;
}

export const RECORDED_REPLAY_STATES = ['running', 'passed', 'mismatch', 'failed'] as const;
export type RecordedReplayStatus = (typeof RECORDED_REPLAY_STATES)[number];

/** Прогон «Прогнать все» по проекту: один на проект, последний помнится до перезапуска панели. */
export interface RecordedReplayState {
  status: RecordedReplayStatus;
  startedAt: string;
  finishedAt?: string;
  environmentId?: string;
  /** Сколько записанных кейсов ушло в прогон. */
  total: number;
  /** Запись прогона в истории блока. */
  runId?: string;
  mismatch?: RecordedMismatch;
  /** Прогон не дал записи (ошибка запуска) — хвост вывода. */
  error?: string;
}

/** `GET /api/project-tests/recorded` */
export interface RecordedView {
  cases: RecordedCaseView[];
  replay?: RecordedReplayState;
}

/** `POST /api/project-tests/recorded` — записать проход в кейс и спек. */
export interface RecordedRecordBody {
  /** Каталог проекта — как у прочих ручек раздела. */
  path: string;
  groupId: string;
  title: string;
  taskId: string;
  steps: BrowseStep[];
  gaps: BrowseGap[];
  /** Перезапись этого кейса (сценарий устарел); нет — новый кейс. */
  caseId?: string;
}

export interface RecordedRecordReply {
  groupId: string;
  caseId: string;
  file: string;
  testName: string;
  created: boolean;
  /** Сколько шагов легло «не проверено». */
  unchecked: number;
}

/** `POST /api/project-tests/recorded/walk` — начать проход ядра по стенду из блока «Тесты». */
export interface RecordedWalkBody {
  /** Каталог проекта — как у прочих ручек раздела. */
  path: string;
  /** Что пройти — словами человека. */
  goal: string;
  title?: string;
  environmentId?: string;
  lang?: 'ru' | 'en';
}

export interface RecordedWalkReply {
  taskId: string;
}

/** `POST /api/project-tests/recorded/replay` — «Прогнать все». */
export interface RecordedReplayBody {
  /** Каталог проекта — как у прочих ручек раздела. */
  path: string;
  environmentId?: string;
  lang?: 'ru' | 'en';
}

/** `POST /api/project-tests/recorded/verdict` — решение человека по расхождению. */
export interface RecordedVerdictBody {
  /** Каталог проекта — как у прочих ручек раздела. */
  path: string;
  verdict: RecordedVerdict;
}
