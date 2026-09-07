/**
 * Тест-кейсы проекта: что проверяют, чем это кончилось и как это шло.
 *
 * Кейсы живут НЕ в панели, а в самом проверяемом проекте — `.agent/tests/`,
 * по файлу на группу (`gui.tests.json`, `e2e.tests.json`). Причина простая:
 * тесты описывают ЭТОТ код, переезжают вместе с ним и должны быть видны тому,
 * кто откроет репозиторий без панели. Панель здесь — редактор и пульт, а не
 * хранилище; своей базы у неё нет и здесь тоже не заводится.
 *
 * Рядом с файлами групп лежит остальная тестовая обвязка проекта, и она тоже
 * файлами: `_shared.steps.json` (общие шаги), `environments.json`
 * (конфигурации-окружения), `schema.json` (свои поля и статусы проекта),
 * `views.json` (сохранённые фильтры), `plans/*.plan.json` (тест-планы),
 * `runs/*.run.json` (история прогонов), `attachments/` (доказательства).
 * Версионирование, авторство и ревью такого набора даёт git — своего
 * механизма версий здесь нет намеренно.
 *
 * Файлы правят обе стороны: человек через панель и агент своими руками во
 * время прогона. Поэтому формат обязан переживать чужую запись — группа со
 * сломанным JSON гасит СВОЮ вкладку (`error`), а не весь список, и файл при
 * этом не перезаписывается: чинить сломанное молчаливой перезаписью значит
 * потерять работу, которую кто-то только что написал.
 *
 * Статус кейса — это ПОСЛЕДНИЙ результат, а не история: человек спрашивает
 * «что сейчас красное». История лежит отдельно, в `runs/`, и по ней считаются
 * тренды, нестабильность и отчёты.
 */

/** Чем кончился прогон кейса или отдельного шага. */
export type ProjectTestStatus =
  /** Ещё не гоняли — так рождается каждый новый кейс. */
  | 'unknown'
  /** Прогон идёт прямо сейчас. */
  | 'running'
  | 'passed'
  | 'failed'
  /** Проверить не удалось: не открылось, нет данных, не к чему применить. */
  | 'skipped'
  /** Проверке мешает чужая поломка: до шага просто не дойти. */
  | 'blocked';

/** Все статусы одним списком — по нему их разбирают и сервер, и клиенты. */
export const PROJECT_TEST_STATUSES: readonly ProjectTestStatus[] = [
  'unknown',
  'running',
  'passed',
  'failed',
  'skipped',
  'blocked',
];

/** Кто завёл кейс. Человеческие агент не удаляет — только дополняет. */
export type ProjectTestSource = 'agent' | 'human';

/** Тип рабочего элемента: подробный кейс или короткий чек-лист. */
export type ProjectTestKind = 'case' | 'checklist';

/** Важность: по ней отбирают, что гонять, когда времени на всё нет. */
export type ProjectTestPriority = 'blocker' | 'high' | 'medium' | 'low';

/** Готовность самого описания — черновик, готов, устарел. */
export type ProjectTestReadiness = 'draft' | 'ready' | 'obsolete';

/** Состояние автоматизации кейса. */
export type ProjectTestAutomationStatus =
  /** Проверяется руками или агентом по описанию. */
  | 'manual'
  /** Решено автоматизировать, кода ещё нет. */
  | 'toAutomate'
  /** Есть код теста, кейс гоняется им. */
  | 'automated';

/** Один шаг сценария. */
export interface ProjectTestStep {
  /** Что сделать: нажать, ввести, перейти. */
  action: string;
  /** Что должно получиться именно на этом шаге. */
  expected?: string;
  /** Тестовые данные шага — то, что подставляют в поля. */
  data?: string;
  /**
   * Ссылка на общий шаг (`_shared.steps.json`). Когда она есть, `action`
   * держит подпись для чтения, а раскрывается шаг по `ref`.
   */
  ref?: string;
}

/** Внешняя ссылка кейса: требование, задача, MR, документ. */
export interface ProjectTestLink {
  type: 'requirement' | 'issue' | 'mr' | 'doc';
  url: string;
  title?: string;
}

/** Параметр кейса и его значения — из них разворачиваются тест-поинты. */
export interface ProjectTestParameter {
  /** Имя без `%`: в шагах оно пишется как `%login`. */
  name: string;
  values: string[];
}

/** Привязка кейса к коду автотеста. */
export interface ProjectTestAutomation {
  status: ProjectTestAutomationStatus;
  /** Путь файла теста от корня проекта. */
  file?: string;
  /** Имя теста внутри файла — по нему сходятся результаты из CI. */
  testName?: string;
}

/** Заведённый по провалу дефект. */
export interface ProjectTestDefect {
  url: string;
  title?: string;
  createdAt?: string;
}

/** Один тест-кейс. */
export interface ProjectTestCase {
  /** Устойчивый идентификатор внутри группы: по нему сходятся правки обеих сторон. */
  id: string;
  /** Кейс или чек-лист. Чек-лист живёт без ожиданий и условий. */
  type: ProjectTestKind;
  title: string;
  /** Зачем этот кейс нужен — то, что нельзя вывести из шагов. */
  purpose?: string;
  /** Зона приложения: по ней гоняют «только эту часть», а не всё подряд. */
  area?: string;
  /** Путь секции внутри группы («Чат/Вложения») — панель рисует по нему дерево. */
  section?: string;
  /** С какого состояния начинать. Агенту это нужнее, чем человеку. */
  precondition?: string;
  /** Что нажать и в каком порядке. */
  steps: ProjectTestStep[];
  /** Что должно получиться в целом. */
  expected?: string;
  /** Что вернуть после проверки, чтобы следующий кейс начинался с чистого. */
  postcondition?: string;
  /** Чем именно доказывается результат: текст на экране, запись в базе, ответ сети. */
  oracle?: string;
  priority?: ProjectTestPriority;
  readiness?: ProjectTestReadiness;
  /** Ожидаемая длительность прохождения, минуты. */
  duration?: number;
  tags?: string[];
  links?: ProjectTestLink[];
  /** Свои поля проекта — их описывает `schema.json`. */
  attributes?: Record<string, string>;
  parameters?: ProjectTestParameter[];
  /** Пути вложений от корня проекта. */
  attachments?: string[];
  automation?: ProjectTestAutomation;
  /** Файлы кода, которых кейс касается: по ним считается отбор по диффу. */
  codePaths?: string[];
  defects?: ProjectTestDefect[];
  status: ProjectTestStatus;
  /** Пользовательский статус проекта (`schema.json`), если он используется. */
  statusId?: string;
  /** Что агент или человек увидел на самом деле — заполняется прогоном. */
  note?: string;
  /** Момент последнего прогона, ISO. */
  lastRunAt?: string;
  /** Прогон, давший последний результат — по нему открывается запись в истории. */
  lastRunId?: string;
  source: ProjectTestSource;
  /** Момент последней правки самого кейса, ISO. */
  updatedAt?: string;
  /** Убран из списка, но не потерян. */
  archived?: boolean;
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

/** Общий шаг: кусок сценария, который повторяется в десятке кейсов. */
export interface ProjectTestSharedStep {
  id: string;
  title: string;
  steps: ProjectTestStep[];
  description?: string;
  updatedAt?: string;
}

/** Окружение-конфигурация, на котором гоняют: стенд, браузер, система. */
export interface ProjectTestEnvironment {
  id: string;
  title: string;
  /** Адрес приложения для этого окружения. */
  baseUrl?: string;
  browser?: string;
  os?: string;
  /** Команда подъёма стенда, если его нужно поднимать. */
  start?: string;
  notes?: string;
  /** Берётся, когда явно ничего не выбрали. */
  isDefault?: boolean;
  archived?: boolean;
}

/** Своё поле проекта: колонка в списке и поле в форме кейса. */
export interface ProjectTestAttributeDef {
  key: string;
  title: string;
  type: 'text' | 'select' | 'number';
  options?: string[];
  required?: boolean;
}

/** Пользовательский статус проекта поверх канонической пятёрки. */
export interface ProjectTestStatusDef {
  id: string;
  title: string;
  /** К какому каноническому статусу он приравнивается в отчётах. */
  group: ProjectTestStatus;
}

/** `schema.json` проекта: свои поля и свои статусы. */
export interface ProjectTestSchema {
  attributes: ProjectTestAttributeDef[];
  statuses: ProjectTestStatusDef[];
}

/** Отбор кейсов: и фильтр списка, и содержимое динамического набора. */
export interface ProjectTestFilter {
  groupIds?: string[];
  sections?: string[];
  areas?: string[];
  tags?: string[];
  priorities?: ProjectTestPriority[];
  statuses?: ProjectTestStatus[];
  types?: ProjectTestKind[];
  automation?: ProjectTestAutomationStatus[];
  readiness?: ProjectTestReadiness[];
  /** Подстрока по названию, цели и шагам. */
  query?: string;
  /** Показывать ли убранное в архив. */
  includeArchived?: boolean;
}

/** Сохранённый фильтр: он же динамический набор тест-плана. */
export interface ProjectTestView {
  id: string;
  title: string;
  filter: ProjectTestFilter;
  createdAt?: string;
}

/** Тест-план: что проверяем, на чём и к какому сроку. */
export interface ProjectTestPlan {
  id: string;
  title: string;
  /** Продукт и версия — то, что попадёт в отчёт. */
  product?: string;
  version?: string;
  description?: string;
  /** Сроки, ISO-даты. */
  from?: string;
  to?: string;
  tags?: string[];
  /** Статический список кейсов. */
  caseIds?: string[];
  /** Динамический набор: кейсы берутся фильтром в момент прогона. */
  filter?: ProjectTestFilter;
  /** Окружения, на которых план гоняют: кейс × окружение = тест-поинты. */
  environmentIds?: string[];
  createdAt?: string;
  updatedAt?: string;
  /** План закрыт для правок — чтобы прогон не поехал под руками. */
  locked?: boolean;
  archived?: boolean;
}

/** Тест-поинт: кейс, развёрнутый до одного конкретного прохода. */
export interface ProjectTestPoint {
  /** Устойчивый ключ: группа, кейс, окружение и набор параметров. */
  id: string;
  groupId: string;
  caseId: string;
  title: string;
  environmentId?: string;
  /** Значения параметров этого прохода. */
  params?: Record<string, string>;
  priority?: ProjectTestPriority;
  duration?: number;
  automation?: ProjectTestAutomation;
  status: ProjectTestStatus;
}

/** Результат одного шага внутри прохода. */
export interface ProjectTestStepResult {
  index: number;
  status: ProjectTestStatus;
  note?: string;
  attachments?: string[];
}

/** Результат одного тест-поинта в прогоне. */
export interface ProjectTestPointResult {
  pointId: string;
  groupId: string;
  caseId: string;
  environmentId?: string;
  params?: Record<string, string>;
  status: ProjectTestStatus;
  statusId?: string;
  note?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  steps?: ProjectTestStepResult[];
  attachments?: string[];
  /** Ссылки на заведённые дефекты. */
  defects?: string[];
}

/** Что делает запущенный прогон. */
export type ProjectTestRunMode =
  /** Агент изучает приложение и пишет/обновляет кейсы. */
  | 'generate'
  /** Агент проходит кейсы живьём и проставляет статусы. */
  | 'run'
  /** Свободный поиск по хартии: агент ищет то, на что кейсов ещё нет. */
  | 'explore'
  /** Агент превращает стабильные кейсы в код автотестов. */
  | 'automate'
  /** Человек проходит кейсы сам, шаг за шагом, в панели. */
  | 'manual'
  /** Результаты пришли из CI — прогон не запускался панелью. */
  | 'import';

export type ProjectTestRunStatus = 'running' | 'done' | 'error' | 'stopped';

/** Кто прогонял. */
export type ProjectTestActor = 'agent' | 'human' | 'ci';

/** Сводка по прогону — то, что видно в списке истории без раскрытия. */
export interface ProjectTestRunSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  blocked: number;
}

/** Прогон агента или человека: генерация кейсов, проверка, автоматизация. */
export interface ProjectTestRun {
  id: string;
  projectPath: string;
  mode: ProjectTestRunMode;
  actor: ProjectTestActor;
  /** Группа, к которой относится прогон; пусто — все группы. */
  groupId?: string;
  /** Отобранные кейсы; пусто — вся группа. */
  caseIds?: string[];
  /** План, по которому идёт прогон. */
  planId?: string;
  /** Окружение прогона. */
  environmentId?: string;
  /** Ветка и коммит на момент старта — без них результат не воспроизвести. */
  branch?: string;
  commit?: string;
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
  /** Результаты по тест-поинтам — заполняются по ходу. */
  results?: ProjectTestPointResult[];
  summary?: ProjectTestRunSummary;
}

/** Запись прогона на диске (`runs/<id>.run.json`) — без лога и без пути проекта. */
export interface ProjectTestRunRecord {
  id: string;
  mode: ProjectTestRunMode;
  actor: ProjectTestActor;
  groupId?: string;
  planId?: string;
  environmentId?: string;
  branch?: string;
  commit?: string;
  scope?: string;
  status: ProjectTestRunStatus;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  tokens?: number;
  costUsd?: number;
  sessionId?: string;
  results: ProjectTestPointResult[];
  summary: ProjectTestRunSummary;
}

/** Насколько кейс стабилен по истории прогонов. */
export interface ProjectTestFlaky {
  caseId: string;
  groupId: string;
  title: string;
  /** Доля совпадающих подряд результатов, 0–100. */
  stability: number;
  /** Сколько прогонов участвовало в расчёте. */
  runs: number;
  /** Сколько раз результат менялся. */
  flips: number;
}

/**
 * Одна и та же поломка, встреченная в разных кейсах.
 *
 * Сводится по тексту, который оставил исполнитель: десять красных кейсов с
 * «страница не открылась» — это один сломанный вход, а не десять дефектов, и
 * без такой группировки отчёт заставляет открывать каждый кейс отдельно.
 */
export interface ProjectTestFailureGroup {
  /** Причина словами — заметка самого свежего из совпавших результатов. */
  reason: string;
  /** Сколько результатов сошлось в эту причину. */
  count: number;
  /** Кейсы, которых это касается. */
  cases: { groupId: string; caseId: string; title: string }[];
  /** Когда встретилась в последний раз. */
  lastSeenAt?: string;
}

/** Отчёт по истории: тренды, покрытие, нестабильные, деньги и время. */
export interface ProjectTestReport {
  /** Прогоны от новых к старым. */
  runs: ProjectTestRunRecord[];
  /** Кейсы по зонам: сколько всего и сколько зелёных. */
  areas: { area: string; total: number; passed: number; failed: number; unknown: number }[];
  /** Покрытие автоматизацией. */
  automation: { manual: number; toAutomate: number; automated: number };
  flaky: ProjectTestFlaky[];
  /** Провалы, сведённые по причине, — от самой частой к редкой. */
  failures: ProjectTestFailureGroup[];
  /** Суммарно по последним прогонам. */
  totals: {
    runs: number;
    tokens: number;
    costUsd: number;
    durationMs: number;
    lastRunAt?: string;
  };
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
  sharedSteps: ProjectTestSharedStep[];
  environments: ProjectTestEnvironment[];
  schema: ProjectTestSchema;
  views: ProjectTestView[];
  plans: ProjectTestPlan[];
  /** Ветка и коммит рабочей копии — контекст, в котором сейчас смотрят кейсы. */
  branch?: string;
  commit?: string;
}

/** Правка кейса из панели. Нет `id` — кейс создаётся. */
export interface ProjectTestCaseInput {
  id?: string;
  type?: ProjectTestKind;
  title: string;
  purpose?: string;
  area?: string;
  section?: string;
  precondition?: string;
  /** Шаги приходят объектами; строки тоже принимаются и достраиваются. */
  steps: (ProjectTestStep | string)[];
  expected?: string;
  postcondition?: string;
  oracle?: string;
  priority?: ProjectTestPriority;
  readiness?: ProjectTestReadiness;
  duration?: number;
  tags?: string[];
  links?: ProjectTestLink[];
  attributes?: Record<string, string>;
  parameters?: ProjectTestParameter[];
  attachments?: string[];
  automation?: ProjectTestAutomation;
  codePaths?: string[];
  status?: ProjectTestStatus;
  statusId?: string;
  note?: string;
  archived?: boolean;
}

/** Массовое действие над отмеченными кейсами. */
export interface ProjectTestBulkInput {
  groupId: string;
  caseIds: string[];
  /** Что сделать: переставить поле, перенести, размножить, убрать в архив. */
  action:
    | 'tag'
    | 'untag'
    | 'priority'
    | 'readiness'
    | 'automation'
    | 'section'
    | 'move'
    | 'duplicate'
    | 'archive'
    | 'restore'
    | 'delete';
  /** Значение действия: тег, приоритет, секция, группа-приёмник. */
  value?: string;
}

/** Запрос на запуск прогона или генерации. */
export interface ProjectTestRunRequest {
  projectPath: string;
  mode: ProjectTestRunMode;
  groupId?: string;
  caseIds?: string[];
  planId?: string;
  environmentId?: string;
  scope?: string;
  /**
   * Полный перетест: статусы всех задетых кейсов сбрасываются перед стартом, и
   * агенту велено пройти их заново, а не доверять прошлым галочкам.
   */
  full?: boolean;
  /** Гнать только то, чего касаются несохранённые правки рабочей копии. */
  changedOnly?: boolean;
}

/**
 * Одна запись истории файла кейсов из git. Своего механизма версий у раздела
 * нет намеренно: кейсы лежат в репозитории, и git знает о них больше.
 */
export interface ProjectTestHistoryEntry {
  /** Короткий хеш коммита. */
  hash: string;
  /** Дата коммита, ISO. */
  date: string;
  author: string;
  subject: string;
  /** Сколько строк в ЭТОМ файле добавлено и убрано коммитом. */
  added?: number;
  removed?: number;
}

/** Кейсы, задетые правками рабочей копии, — основа отбора по диффу. */
export interface ProjectTestImpact {
  /** Изменённые файлы, от которых считали. */
  files: string[];
  /** Кейсы, у которых `codePaths` или зона пересеклись с изменениями. */
  cases: { groupId: string; caseId: string; title: string; reason: string }[];
}

/** Ручной прогон человеком: то, что панель держит открытым, пока он идёт. */
export interface ProjectTestManualSession {
  runId: string;
  planId?: string;
  environmentId?: string;
  points: ProjectTestPoint[];
  /** Индекс текущего поинта. */
  index: number;
  results: ProjectTestPointResult[];
  startedAt: string;
  finishedAt?: string;
}

/** Отметка результата в ручном прогоне. */
export interface ProjectTestManualResultInput {
  runId: string;
  pointId: string;
  status: ProjectTestStatus;
  statusId?: string;
  note?: string;
  steps?: ProjectTestStepResult[];
  attachments?: string[];
  durationMs?: number;
}

/** Черновик дефекта по проваленному кейсу. */
export interface ProjectTestDefectDraft {
  title: string;
  body: string;
  /** Куда его можно завести прямо отсюда. */
  targets: ('github' | 'gitlab')[];
  /** Чем именно это будет сделано — `gh` или `glab` из PATH. */
  hint?: string;
}

/** Форматы, из которых панель умеет забирать результаты и кейсы. */
export type ProjectTestImportFormat =
  'junit' | 'playwright' | 'allure' | 'testrail-csv' | 'csv' | 'xlsx';

/** Итог импорта: что нашли и что легло на кейсы. */
export interface ProjectTestImportResult {
  format: ProjectTestImportFormat;
  /** Сколько записей прочитали из файла. */
  read: number;
  /** Сколько кейсов обновилось или завелось. */
  matched: number;
  created: number;
  /** Что не удалось сопоставить — по именам тестов. */
  unmatched: string[];
  runId?: string;
}
