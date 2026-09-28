/**
 * Папка e2e проекта: где лежат НАСТОЯЩИЕ автотесты, которые пишут агенты, и
 * как они сводятся с кейсами раздела «Тесты».
 *
 * Кейсы (описание, приоритет, результат) по-прежнему живут в `.agent/tests/`;
 * код тестов — в папке e2e. Связь — поле `automation` кейса и метка `[id]` в
 * имени теста: ни одно из двух мест не дублирует другое.
 */

import type { ProjectTestRunSummary } from './project-tests-summary';

/** Чем проект гоняет e2e — по конфигу или по виду файлов. */
export type ProjectTestE2eFramework = 'playwright' | 'cypress' | 'pytest' | 'unknown';

/**
 * Откуда известна папка: из `testDir` конфига Playwright, по обычному имени
 * каталога (`e2e/`, `tests/e2e/`…) или её завела панель.
 */
export type ProjectTestE2eOrigin = 'config' | 'folder' | 'panel';

/** Папка e2e проекта, как её видит панель. */
export interface ProjectTestE2eFolder {
  /** `found` — лежала в проекте, `created` — завела панель, `missing` — нет. */
  state: 'found' | 'created' | 'missing';
  /** Путь от корня проекта, через `/`. Пусто, когда папки нет. */
  dir?: string;
  origin?: ProjectTestE2eOrigin;
  framework: ProjectTestE2eFramework;
  /** Сколько файлов тестов нашлось в папке (с потолком разбора). */
  specs: number;
  /** Скрыта ли папка от git строкой в `.git/info/exclude` (только у заведённой панелью). */
  excluded: boolean;
  /** Проект под git — без него скрывать не от кого. */
  git: boolean;
  /** Другие подходящие папки: в монорепозитории их бывает несколько. */
  candidates?: string[];
}

/**
 * Своя команда прогона проекта — `.agent/tests/automation.json`
 * (`{ "version": 1, "command": "…" }`). Для проекта, чьи проверки — не папка
 * Playwright/Cypress/pytest: скрипты, наборы vitest, что угодно, что пишет JUnit.
 *
 * В `command` — подстановки: `{files}` — файлы выбранных кейсов (`automation.file`,
 * без повторов; без выбора — всех кейсов с автотестом), `{report}` — путь отчёта, назначенный панелью; тот же путь — в
 * переменной `AGENTDECK_JUNIT_REPORT`. Команда без `{files}` гонит весь набор.
 */
export interface ProjectTestAutomationCommand {
  command: string;
  /** Путь отчёта от корня, если команда пишет его сама, а не туда, куда велит панель. */
  report?: string;
  /** Потолок прогона в минутах: дольше — прогон останавливается. */
  timeoutMinutes?: number;
}

/**
 * Что сделалось с папкой e2e при добавлении проекта в реестр — ответ человеку
 * «что панель сделала с моим проектом», а не молчаливая папка в каталоге.
 *
 * `created` — своей папки не было, панель завела заготовку (спрятав от git);
 * `found` — своя нашлась, её тесты сведены в кейсы (`sync`; нет — файлов тестов
 * в ней ноль); `failed` — сбой, проект всё равно добавлен.
 */
export type ProjectE2eOnboarding =
  | { state: 'created'; dir: string; excluded: boolean }
  | {
      state: 'found';
      dir: string;
      framework: ProjectTestE2eFramework;
      sync?: Pick<ProjectTestE2eSync, 'tests' | 'added' | 'groups'>;
    }
  | { state: 'failed' };

/** Ответ на добавление проекта: запись реестра и итог папки e2e. */
export interface ProjectAdded {
  id: string;
  name: string;
  path: string;
  /** Нет — сверять было нечего (у панели нет каталога данных). */
  e2e?: ProjectE2eOnboarding;
}

/** Итог сверки папки e2e с кейсами. */
export interface ProjectTestE2eSync {
  dir: string;
  /** Файлов тестов разобрано. */
  files: number;
  /** Тестов найдено в них. */
  tests: number;
  /** Кейсов заведено по новым тестам. */
  added: number;
  /** Кейсов, у которых обновилась привязка к коду (файл, имя теста). */
  linked: number;
  /** Групп заведено. */
  groups: string[];
  /**
   * Тесты, которые не разобрать без запуска: имя собирается из переменных
   * (шаблонная строка с `${…}`, цикл). Угадывать их панель не берётся.
   */
  skipped: { file: string; reason: string }[];
  /** Кейсы с привязкой к файлу папки, чьих тестов в коде больше нет. */
  missing: { groupId: string; caseId: string; file: string }[];
}

/**
 * Прогон автотестов папки самой панелью — без агента и без токенов: команда
 * каркаса в каталоге проекта, отчёт junit — в результаты кейсов.
 */
export interface ProjectTestE2eRun {
  status: 'running' | 'done' | 'error' | 'stopped';
  /** Командная строка как есть — человек видит, что именно запущено. */
  command: string;
  startedAt: string;
  finishedAt?: string;
  /** Код выхода команды; красные тесты — тоже ненулевой код, это не сбой панели. */
  exitCode?: number | null;
  /** Хвост вывода команды. */
  log: string;
  /** Запись в истории прогонов, куда легли результаты. */
  runId?: string;
  /** Сколько результатов прочитано из отчёта и сколько легло на кейсы. */
  imported?: { read: number; matched: number; unmatched: number };
  /**
   * Итог по статусам — то, что человек спрашивает первым: прошло или упало.
   * Без него «Готово» стояло и над красным набором.
   */
  summary?: ProjectTestRunSummary;
  /** Имена первых тестов без кейса (до пяти): «без кейса 1» без имени не проверить. */
  unmatchedNames?: string[];
  /** Почему результатов нет: команда не запустилась, отчёт не появился. */
  error?: string;
  /** Код текста `error` для перевода. */
  errorCode?: 'e2e-run-no-report' | 'e2e-run-spawn' | 'e2e-run-import' | 'e2e-run-not-installed';
  /** Подстановки текста `errorCode`: где и что выполнить, если раннера нет. */
  errorParams?: { dir: string; install: string };
}

/** Каркас модульных тестов, найденный в проекте, и где именно он назван. */
export interface ProjectTestPyramidFramework {
  name: 'vitest' | 'jest' | 'mocha' | 'pytest' | 'go';
  /** Файл, по которому каркас найден (путь от корня), — чтобы человек проверил. */
  source: string;
}

/** Сколько файлов и тестов в слое. Тесты считаются по тексту, без запуска. */
export interface ProjectTestPyramidCount {
  files: number;
  tests: number;
  /** Тесты с именем из переменных (цикл, `each`) — посчитать их без запуска нельзя. */
  dynamic: number;
}

/**
 * Пирамида тестов проекта: модульные и интеграционные рядом с e2e.
 *
 * Панель не гадает. Слой известен, только если его каркас назван конфигом
 * проекта (файл настроек, зависимость, `go.mod`); нет каркаса — слой
 * `undefined`, и экран пишет «не известно», а не ноль. Модульные и
 * интеграционные делятся, только если проект сам помечает интеграционные (имя
 * `*.integration.*`, каталог `integration`, `@pytest.mark.integration`,
 * `//go:build integration`); без меток — один общий счёт (`code`).
 */
export interface ProjectTestPyramid {
  frameworks: ProjectTestPyramidFramework[];
  /** Разделены ли модульные и интеграционные метками самого проекта. */
  split: boolean;
  /** Модульные — только при `split`. */
  unit?: ProjectTestPyramidCount;
  /** Интеграционные — только при `split`. */
  integration?: ProjectTestPyramidCount;
  /** Все тесты кода без деления — когда меток нет. */
  code?: ProjectTestPyramidCount;
  /** Тесты папки e2e; `undefined` — папки нет. */
  e2e?: ProjectTestPyramidCount & { dir: string };
  /** Обход упёрся в потолок: счёт — нижняя граница. */
  truncated: boolean;
  checkedAt: string;
}
