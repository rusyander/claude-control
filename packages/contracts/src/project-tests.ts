/**
 * Тест-кейсы проекта: что агент проверяет в интерфейсе и чем это кончилось.
 *
 * Кейсы живут НЕ в панели, а в самом проверяемом проекте — `.agent/tests/`,
 * по файлу на группу (`gui.tests.json`, `e2e.tests.json`). Причина простая:
 * тесты описывают ЭТОТ код, переезжают вместе с ним и должны быть видны тому,
 * кто откроет репозиторий без панели. Панель здесь — редактор и пульт, а не
 * хранилище; своей базы у неё нет и здесь тоже не заводится.
 *
 * Файл правят обе стороны: человек через панель и агент своими руками во время
 * прогона. Поэтому формат обязан переживать чужую запись — группа со сломанным
 * JSON гасит СВОЮ вкладку (`error`), а не весь список, и файл при этом не
 * перезаписывается: чинить сломанное молчаливой перезаписью значит потерять
 * работу, которую кто-то только что написал.
 *
 * Статус — свойство кейса, а не отдельная таблица прогонов: человек спрашивает
 * «что сейчас красное», а не «как оно было в среду». История прогона остаётся в
 * транскрипте сессии, которую панель заводит под прогон.
 */

/** Чем кончился последний прогон кейса. */
export type ProjectTestStatus =
  /** Ещё не гоняли — так рождается каждый новый кейс. */
  | 'unknown'
  /** Прогон идёт прямо сейчас. */
  | 'running'
  | 'passed'
  | 'failed'
  /** Проверить не удалось: не открылось, нет данных, не к чему применить. */
  | 'skipped';

/** Кто завёл кейс. Человеческие агент не удаляет — только дополняет. */
export type ProjectTestSource = 'agent' | 'human';

/** Один тест-кейс. */
export interface ProjectTestCase {
  /** Устойчивый идентификатор внутри группы: по нему сходятся правки обеих сторон. */
  id: string;
  title: string;
  /** Зачем этот кейс нужен — то, что нельзя вывести из шагов. */
  purpose?: string;
  /** Зона приложения: по ней гоняют «только эту часть», а не всё подряд. */
  area?: string;
  /** Что нажать и в каком порядке. */
  steps: string[];
  /** Что должно получиться. */
  expected?: string;
  status: ProjectTestStatus;
  /** Что агент увидел на самом деле — заполняется прогоном. */
  note?: string;
  /** Момент последнего прогона, ISO. */
  lastRunAt?: string;
  source: ProjectTestSource;
  /** Момент последней правки самого кейса, ISO. */
  updatedAt?: string;
}

/** Вкладка модалки: файл `.agent/tests/<id>.tests.json` целиком. */
export interface ProjectTestGroup {
  /** Имя файла без суффикса: `gui`, `e2e`, `smoke`. */
  id: string;
  title: string;
  /** О чём эта группа — показывается над списком. */
  description?: string;
  /** Путь файла от корня проекта — человеку видно, что где лежит. */
  file: string;
  cases: ProjectTestCase[];
  /** Файл не разобрался: вкладка показывает причину вместо списка. */
  error?: string;
}

/** Что делает запущенный прогон. */
export type ProjectTestRunMode =
  /** Агент изучает приложение и пишет/обновляет кейсы. */
  | 'generate'
  /** Агент проходит кейсы живьём и проставляет статусы. */
  | 'run';

export type ProjectTestRunStatus = 'running' | 'done' | 'error' | 'stopped';

/** Прогон агента: генерация кейсов или их проверка. */
export interface ProjectTestRun {
  id: string;
  projectPath: string;
  mode: ProjectTestRunMode;
  /** Группа, к которой относится прогон; пусто — все группы. */
  groupId?: string;
  /** Отобранные кейсы; пусто — вся группа. */
  caseIds?: string[];
  /** Зона или пожелание человека словами («только чат», «добавь тесты на аналитику»). */
  scope?: string;
  status: ProjectTestRunStatus;
  startedAt: string;
  finishedAt?: string;
  /** Хвост вывода агента — полный лог прогона в модалке. */
  log: string;
  error?: string;
  tokens: number;
  costUsd: number;
  /** Сессия CLI: по ней прогон открывается в чате как обычный разговор. */
  sessionId?: string;
}

/** Ответ на «покажи тесты этого проекта». */
export interface ProjectTestsView {
  projectPath: string;
  /** Папка с файлами кейсов от корня проекта. */
  dir: string;
  groups: ProjectTestGroup[];
  /** Идущий или последний прогон этого проекта. */
  run?: ProjectTestRun;
  /**
   * Вписано ли соглашение о кейсах в `CLAUDE.md` проекта. Пока нет — кейсы
   * ведут только прогоны из этого окна; обычный разговор о них не знает.
   */
  hasConvention: boolean;
}

/** Правка кейса из панели. Нет `id` — кейс создаётся. */
export interface ProjectTestCaseInput {
  id?: string;
  title: string;
  purpose?: string;
  area?: string;
  steps: string[];
  expected?: string;
  status?: ProjectTestStatus;
  note?: string;
}

/** Запрос на запуск прогона или генерации. */
export interface ProjectTestRunRequest {
  projectPath: string;
  mode: ProjectTestRunMode;
  groupId?: string;
  caseIds?: string[];
  scope?: string;
  /**
   * Полный перетест: статусы всех задетых кейсов сбрасываются перед стартом, и
   * агенту велено пройти их заново, а не доверять прошлым галочкам.
   */
  full?: boolean;
}
