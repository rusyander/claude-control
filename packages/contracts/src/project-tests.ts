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
  /**
   * Устойчивый ключ, которым тест помечен в самом коде (`@TC-14`, свойство
   * junit, метка allure). Сильнее имени и проверяется первым.
   *
   * Имя теста — плохой ключ: его меняют при первом же рефакторинге, и импорт
   * молча кладёт результат в «несопоставленные», а история кейса обрывается без
   * единой ошибки. Ключ переживает переименование, потому что живёт рядом с
   * тестом и меняется только осознанно.
   */
  externalId?: string;
}

/** Как трекер отвечает про судьбу заведённого дефекта. */
export type ProjectTestDefectState = 'open' | 'closed' | 'unknown';

/** Заведённый по провалу дефект. */
export interface ProjectTestDefect {
  url: string;
  title?: string;
  createdAt?: string;
  /** Ключ задачи (`QA-42`) или номер issue — по нему спрашивают статус. */
  key?: string;
  /**
   * Открыт дефект или уже закрыт. Пусто — статуса ещё не спрашивали.
   *
   * Ради этого поля дефект и связывают: закрытый дефект на красном кейсе
   * означает «перепроверь», и без ответа трекера этот момент не наступает
   * никогда — кейс так и остаётся красным до следующего полного прогона.
   */
  state?: ProjectTestDefectState;
  /** Как статус называется у команды: «Готово», «Closed», «В работе». */
  stateLabel?: string;
  /** Когда статус спрашивали последний раз, ISO. */
  stateCheckedAt?: string;
}

/** Один тест-кейс. */
/**
 * Разбор провала: то, без чего провал нельзя ни воспроизвести, ни завести дефектом.
 *
 * «Провалился» без номера шага и без доказательства — это не результат, а
 * впечатление: чинить по нему нечего, а через неделю уже не вспомнить, что
 * именно видели. Панель не выбрасывает такой результат (работу агента терять
 * дороже), но называет его неполным вслух.
 */
export interface ProjectTestFailure {
  /** Номер провалившегося шага, с единицы; пусто — провал не привязан к шагу. */
  step?: number;
  /** Что должно было случиться на этом шаге. */
  expected?: string;
  /** Что случилось на самом деле. */
  actual?: string;
  /**
   * Вторая попытка того же кейса в том же прогоне: `confirmed` — вышло то же
   * самое, `flaky` — попытки разошлись, и кейсу верить нельзя ни в ту, ни в
   * другую сторону.
   */
  retry?: 'confirmed' | 'flaky';
  /** Что вышло во второй раз, когда попытки разошлись. */
  retryNote?: string;
}

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
  /**
   * Порог расхождения эталонного скриншота, доля пикселей 0–1. Свой у кейса,
   * потому что анимированный экран честно шумит там, где форма входа не имеет
   * права сдвинуться ни на пиксель. Пусто — общий порог панели.
   */
  maxDiffRatio?: number;
  status: ProjectTestStatus;
  /** Пользовательский статус проекта (`schema.json`), если он используется. */
  statusId?: string;
  /**
   * Карантин: провал этого кейса известен и не считается провалом прогона.
   *
   * Не архив и не «пропустить»: кейс гоняется, статус ему ставится настоящий и
   * виден в списке — снимается только право красить прогон и валить `pnpm tests
   * report`, которым гейтят CI. Иначе у команды остаётся ровно два выхода:
   * терпеть вечно красный отчёт (и перестать его читать) или удалить кейс (и
   * забыть о поломке совсем).
   */
  muted?: boolean;
  /** Почему в карантине и до каких пор — иначе через месяц никто не вспомнит. */
  muteReason?: string;
  /** Что агент или человек увидел на самом деле — заполняется прогоном. */
  note?: string;
  /** Разбор последнего провала — заполняется прогоном. */
  failure?: ProjectTestFailure;
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
  /**
   * Все файлы группы, когда она разложена по секциям: большой набор перестаёт
   * помещаться в один файл, и панель разносит его по соседним, читая обратно
   * как одну вкладку. У обычной группы здесь пусто, и файл у неё один.
   */
  files?: string[];
  cases: ProjectTestCase[];
  /** Файл не разобрался: вкладка показывает причину вместо списка. */
  error?: string;
}

/**
 * Эталонный скриншот тест-поинта и итог последнего сравнения с ним.
 *
 * Живёт файлами в проверяемом проекте (`.agent/tests/baselines/`), поэтому
 * смена эталона видна в git-ревью как обычная правка, а не как запись в чужой
 * базе. Не сошлось — рядом ложатся снимок и картинка-разница, а решение
 * принимает человек.
 */
export interface ProjectTestBaseline {
  caseId: string;
  /** Тест-поинт: кейс × окружение × параметры. */
  pointId: string;
  /** Путь эталона от корня проекта. */
  file: string;
  /** Последний снимок, не совпавший с эталоном. */
  actualFile?: string;
  /** Картинка-разница: отличия пурпурным поверх выбеленного фона. */
  diffFile?: string;
  width?: number;
  height?: number;
  updatedAt?: string;
  /**
   * Чем кончилось последнее сравнение: `new` — эталон только что заведён,
   * `error` — сравнить не удалось (битый эталон, другой размер), и это провал,
   * а не совпадение.
   */
  status: 'new' | 'match' | 'diff' | 'error';
  /** Доля различающихся пикселей, 0–1. */
  diffRatio?: number;
  /** Порог, с которым сравнивали. */
  maxDiffRatio?: number;
  /** Причина словами — её показывают человеку. */
  message?: string;
}

/** Общий шаг: кусок сценария, который повторяется в десятке кейсов. */
export interface ProjectTestSharedStep {
  id: string;
  title: string;
  steps: ProjectTestStep[];
  description?: string;
  updatedAt?: string;
}

/**
 * Ссылка на секрет окружения: имя переменной, под которым он уедет в процесс
 * прогона. В файле проекта (`environments.json`, он в git) лежит ТОЛЬКО это —
 * значение хранится зашифрованным в самой панели и наружу не отдаётся.
 */
export interface ProjectTestSecretRef {
  /** Имя переменной окружения: `QA_PASSWORD`, `STAND_TOKEN`. */
  name: string;
  /** Зачем он — подпись в форме и в строке лога, когда значения не нашлось. */
  title?: string;
}

/** Что панель показывает про секрет. Значение не выходит за пределы сервера. */
export interface ProjectTestSecretStatus extends ProjectTestSecretRef {
  /** Задано ли значение на этой машине. */
  hasValue: boolean;
  /** Маска (`abc…4f21`) или пусто, если значения нет. */
  masked: string;
}

/** Ответ на «покажи доступы этого окружения». */
export interface ProjectTestSecretsView {
  environmentId: string;
  secrets: ProjectTestSecretStatus[];
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
  /** Доступы стенда — ИМЕНАМИ переменных; значения панель хранит у себя. */
  secrets?: ProjectTestSecretRef[];
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
  /**
   * Карантин: `true` — только он, `false` — всё кроме него, пусто — вперемешку.
   *
   * Без этого фильтра карантин необратим на практике: кейс перестаёт ронять
   * сборку, теряется среди сотни зелёных и не возвращается уже никогда.
   */
  muted?: boolean;
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
  /** Разбор провала: номер шага, ожидание, что вышло, итог второй попытки. */
  failure?: ProjectTestFailure;
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
  /**
   * Веха, к которой относится прогон: `v1.4`, `спринт 12`, имя релиза.
   *
   * Задаётся человеком или берётся из ближайшего тега git на коммите прогона.
   * Без неё отчёт отвечает только на «как дела сейчас», а вопрос «что проверено
   * в этом релизе» остаётся без ответа — а спрашивают именно его.
   */
  release?: string;
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
  /** Что генерация предложила и что из этого приняли. */
  draft?: ProjectTestDraftOutcome;
  /** След источника генерации: его панель проставит кейсам при приёмке. */
  generate?: ProjectTestGenerateStamp;
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
  /** Веха прогона: задана человеком или снята с тега git. */
  release?: string;
  status: ProjectTestRunStatus;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  tokens?: number;
  costUsd?: number;
  sessionId?: string;
  results: ProjectTestPointResult[];
  summary: ProjectTestRunSummary;
  /** Что генерация предложила и что из этого приняли. */
  draft?: ProjectTestDraftOutcome;
  /**
   * След источника генерации.
   *
   * Лежит в записи прогона, потому что черновик применяют ПОЗЖЕ — иногда через
   * день и уже из другого окна. Взять эти поля из самого файла черновика
   * нельзя: его пишет агент, а ссылка на требование решает, перестанет ли
   * строка матрицы покрытия считаться непокрытой.
   */
  generate?: ProjectTestGenerateStamp;
}

/** Кейс в сравнении двух прогонов: чем он был и чем стал. */
export interface ProjectTestRunDiffCase {
  groupId: string;
  caseId: string;
  title?: string;
  /** Статус в старом прогоне; пусто — кейса в нём не было. */
  from?: ProjectTestStatus;
  /** Статус в новом прогоне; пусто — в этот раз кейс не гоняли. */
  to?: ProjectTestStatus;
  /** Что агент увидел в новом прогоне — по нему и разбирают новый провал. */
  note?: string;
}

/** Один прогон в шапке сравнения: по чему видно, что сравнивают. */
export interface ProjectTestRunDiffSide {
  id: string;
  startedAt: string;
  mode: ProjectTestRunMode;
  planId?: string;
  environmentId?: string;
  release?: string;
  summary: ProjectTestRunSummary;
}

/**
 * Что изменилось между двумя прогонами.
 *
 * Главный вопрос после регресса — «что сломалось с прошлого раза», и до этого
 * сравнения ответа на него не было нигде: человек сличал два списка глазами.
 * Списки не пересекаются: кейс попадает ровно в один из них.
 */
export interface ProjectTestRunDiff {
  from: ProjectTestRunDiffSide;
  to: ProjectTestRunDiffSide;
  /** Было зелено (или не гонялось), стало красным — ради этого списка всё и затевалось. */
  newFailures: ProjectTestRunDiffCase[];
  /** Было красным, стало зелёным. */
  fixed: ProjectTestRunDiffCase[];
  /** Красное и там и там. */
  stillFailing: ProjectTestRunDiffCase[];
  /** Статус не изменился — сюда попадает и зелёное, и пропущенное. */
  untouched: ProjectTestRunDiffCase[];
  /** Кейсы, которых в старом прогоне не было. */
  added: ProjectTestRunDiffCase[];
  /** Кейсы старого прогона, которых в новом нет. */
  removed: ProjectTestRunDiffCase[];
  /**
   * Сравнимы ли прогоны напрямую: разные планы, окружения или режимы означают
   * разные наборы, и «починилось» в таком сравнении может значить «не гоняли».
   */
  comparable: boolean;
  /** Чем именно наборы различаются — строка для человека. */
  warning?: string;
}

/** Что панель проставляет кейсам черновика сама, зная источник генерации. */
export interface ProjectTestGenerateStamp {
  source: ProjectTestGenerateSource;
  /** Требование: ссылка уезжает в `links` каждого принятого кейса. */
  requirementUrl?: string;
  requirementKey?: string;
  /** Файлы диффа: ими заполняется `codePaths`, если агент их не проставил. */
  codePaths?: string[];
  /** Дефект, починку которого закрепляет регрессионный кейс. */
  defectUrl?: string;
}

/**
 * Чем кончилась генерация: сколько предложено, сколько принято и кем.
 *
 * Лежит в записи прогона, а не только в черновике: черновик уезжает в архив, а
 * вопрос «откуда в наборе взялись эти кейсы» задают через месяц.
 */
export interface ProjectTestDraftOutcome {
  /** Прогон-автор: он же имя файла черновика. */
  runId: string;
  /** Сколько правок предложено. */
  proposed: number;
  /** Сколько применено к библиотеке. */
  accepted: number;
  /** Принято без просмотра — по галочке, а не человеком. */
  auto: boolean;
}

/** Что черновик предлагает сделать с кейсом. Удаления здесь нет намеренно. */
export type ProjectTestDraftOp = 'add' | 'update';

/** Судьба одной правки черновика. */
export type ProjectTestDraftState = 'pending' | 'accepted' | 'rejected' | 'rolledBack';

/** Похожий кейс, уже лежащий в библиотеке, — предупреждение о дубле. */
export interface ProjectTestDraftSimilar {
  groupId: string;
  caseId: string;
  title: string;
  /** Мера похожести 0–1. */
  score: number;
}

/** Одна предложенная правка: кейс целиком плюс то, чем его можно откатить. */
export interface ProjectTestDraftItem {
  op: ProjectTestDraftOp;
  groupId: string;
  caseId: string;
  /** Предлагаемая версия кейса. */
  testCase: ProjectTestCase;
  /**
   * Снимок прежней версии. Без него откат невозможен, поэтому панель делает его
   * САМА в момент применения, а не верит тому, что записал агент.
   */
  before?: ProjectTestCase;
  /** Зачем этот кейс нужен — словами агента. */
  reason?: string;
  /** Похожие кейсы библиотеки: строка «похоже на gui-014 (82%)» в приёмке. */
  similarTo?: ProjectTestDraftSimilar[];
  state?: ProjectTestDraftState;
  /** Когда применено — по этой отметке откат отличает свою правку от чужой. */
  appliedAt?: string;
}

/**
 * Черновик генерации: что прогон ПРЕДЛАГАЕТ добавить в библиотеку.
 *
 * Файл `.agent/tests/drafts/<runId>.draft.json` пишет сам агент, а библиотеку
 * меняет только панель, применяя черновик. Так прогон не имеет прав на файлы
 * групп ни при какой галочке, а человек видит предложенное списком, а не
 * `git diff`.
 */
export interface ProjectTestDraft {
  version: 1;
  /** Прогон-автор. */
  runId: string;
  /** Чем вызвана генерация: код, требование, дифф, дефект. */
  source?: string;
  createdAt: string;
  items: ProjectTestDraftItem[];
  /** Путь файла от корня проекта — человеку видно, что где лежит. */
  file: string;
  /** Черновик уже разобран человеком или галочкой. */
  status: 'pending' | 'applied' | 'rejected' | 'rolledBack';
  /** Когда применён. */
  appliedAt?: string;
  /** Применено без просмотра. */
  auto?: boolean;
  /** Файл не разобрался: черновик показывает причину и гасит только себя. */
  error?: string;
  /** Что панель отбросила при чтении: удаления, кейсы без заголовка. */
  warnings?: string[];
}

/**
 * Черновик одной строкой — то, что едет вместе с общим видом раздела.
 *
 * Сам черновик в вид не кладётся: он весит столько же, сколько предложенные
 * кейсы, а вид опрашивают, пока идёт прогон. Полный черновик отдаёт отдельный
 * маршрут — его запрашивают, когда открывают окно приёмки.
 */
export interface ProjectTestDraftSummary {
  runId: string;
  createdAt: string;
  source?: string;
  status: ProjectTestDraft['status'];
  file: string;
  /** Правок всего и сколько из них ждут решения. */
  total: number;
  pending: number;
  accepted: number;
  rejected: number;
  auto?: boolean;
  error?: string;
}

/** Итог применения черновика. */
export interface ProjectTestDraftApplyResult {
  applied: number;
  /** Что не применилось и почему: занятая группа, кейс человека, битая правка. */
  skipped: { caseId: string; reason: string }[];
  draft: ProjectTestDraft;
}

/** Итог отката приёмки. */
export interface ProjectTestDraftRollbackResult {
  /** Сколько добавленных кейсов убрано. */
  removed: number;
  /** Сколько изменённых возвращено из снимка. */
  restored: number;
  /** Кейсы, которых откат не тронул: их успели поправить или прогнать. */
  kept: { caseId: string; reason: string }[];
  draft: ProjectTestDraft;
}

/**
 * Кейс и то, на что он похож в библиотеке.
 *
 * Считается по словам заголовка и шагов, без внешних моделей и эмбеддингов:
 * ответ должен быть мгновенным, воспроизводимым и объяснимым — «эти два кейса
 * совпали на 82% по таким-то словам», а не «модель так решила».
 */
export interface ProjectTestDuplicate {
  groupId: string;
  caseId: string;
  title: string;
  similar: ProjectTestDraftSimilar[];
}

/** Насколько серьёзно замечание линтера. */
export type ProjectTestLintSeverity = 'error' | 'warning' | 'info';

/** Одно замечание по одному кейсу. */
export interface ProjectTestLintFinding {
  /** Правило: `no-oracle`, `step-without-expected`, `stale-draft`… */
  rule: string;
  severity: ProjectTestLintSeverity;
  groupId: string;
  caseId: string;
  title: string;
  /** Что именно не так — по-русски, словами человека. */
  message: string;
  /**
   * Чем это чинится массово. Линтер НИЧЕГО не правит сам: он только называет
   * кнопку, которую нажмёт человек, — иначе «уборка» однажды сотрёт то, что
   * кто-то писал руками.
   */
  fix?: { action: ProjectTestBulkInput['action']; value?: string; label: string };
}

/** Здоровье набора: замечания, дубликаты и счёт по правилам. */
export interface ProjectTestLintReport {
  findings: ProjectTestLintFinding[];
  /** Свод по правилам — карточка рисует его строками, а не списком из тысячи. */
  byRule: {
    rule: string;
    severity: ProjectTestLintSeverity;
    title: string;
    count: number;
  }[];
  duplicates: ProjectTestDuplicate[];
  /** Сколько кейсов проверено. */
  checked: number;
  checkedAt: string;
}

/** Что предлагается сделать с карантином кейса. */
export type ProjectTestQuarantineKind = 'lift' | 'quarantine';

/**
 * Предложение по карантину — предложение, и только.
 *
 * Ни одно из них не применяется само: карантин ставят и снимают руками, обычным
 * массовым действием. Панель, снимающая карантин по счёту зелёных, однажды
 * вернёт в прогон кейс, который человек молча держал выключенным, — и узнают об
 * этом по красной сборке.
 */
export interface ProjectTestQuarantineSuggestion {
  kind: ProjectTestQuarantineKind;
  groupId: string;
  caseId: string;
  title: string;
  /** Чем предложение обосновано — по-русски, с числами. */
  message: string;
  /** Причина карантина, предложенная по умолчанию: человек её правит. */
  reason?: string;
  /** Действующая причина — её видно, когда предлагается карантин снять. */
  muteReason?: string;
  /** Стабильность 0–100 по истории прогонов. */
  stability: number;
  /** Сколько завершённых результатов кейса участвовало в счёте. */
  runs: number;
  /** Сколько зелёных подряд у кейса на сегодня. */
  greenStreak: number;
}

/**
 * Кейс, разошедшийся с требованием: задачу в трекере правили позже кейса.
 *
 * Это не ошибка, а повод перечитать: набор, который никто не пересматривает, за
 * полгода расходится с приложением и начинает врать зелёным статусом.
 */
export interface ProjectTestStaleCase {
  groupId: string;
  caseId: string;
  title: string;
  /** Требование: ключ задачи и ссылка, по которой оно открывается. */
  key: string;
  url?: string;
  requirementUpdatedAt: string;
  caseUpdatedAt: string;
  /** На сколько дней требование новее кейса. */
  days: number;
}

/** Карантин и устаревание: что предложено снять, что поставить, что разошлось. */
export interface ProjectTestQuarantineReport {
  lift: ProjectTestQuarantineSuggestion[];
  quarantine: ProjectTestQuarantineSuggestion[];
  stale: ProjectTestStaleCase[];
  /** Пороги, по которым считали: карточка показывает их человеку. */
  thresholds: { greenStreak: number; stability: number; minRuns: number };
  /** Почему требования не сверялись: Atlassian выключен или Jira не ответила. */
  warning?: string;
  checkedAt: string;
}

/** Множитель риска: из чего складывается число, по которому сортируют. */
export type ProjectTestRiskFactorKey =
  /** Важность кейса: блокер дороже мелочи в любой день. */
  | 'priority'
  /** Чем кончился последний прогон: красное важнее зелёного. */
  | 'outcome'
  /** Нестабильность по истории: кейс, меняющий результат, ничего не доказывает. */
  | 'instability'
  /** Давность последней проверки: непроверенное — тоже риск. */
  | 'age'
  /** Попадание в правки рабочей копии. */
  | 'impact';

/** Один множитель с его значением и словами, которыми он объясняется. */
export interface ProjectTestRiskFactor {
  key: ProjectTestRiskFactorKey;
  /** Значение множителя; 1 — «ничего не добавил». */
  value: number;
  /** Почему именно столько — по-русски, с числами. */
  note: string;
}

/**
 * Риск одного кейса: во что обойдётся НЕ прогнать его сегодня.
 *
 * Это не приоритет и не замена ему: приоритет говорит, насколько кейс важен
 * вообще, риск — насколько он важен ИМЕННО СЕЙЧАС. Кейс, падавший вчера,
 * рискованнее ровно того же кейса, зелёного год.
 */
export interface ProjectTestRiskItem {
  groupId: string;
  caseId: string;
  title: string;
  /** Ключ «группа:кейс» — им кейс адресуют бюджет и сортировка. */
  key: string;
  /** Итог, 0–100. Считается произведением множителей. */
  score: number;
  /** Множители, из которых он собран, — их показывают в подсказке. */
  factors: ProjectTestRiskFactor[];
  /** Итог одной строкой: то, что человек прочитает, не разворачивая. */
  reason: string;
  /** Минуты, которыми кейс обходится бюджету (своя оценка или общее допущение). */
  duration: number;
  /** Своя оценка проставлена или взято допущение — иначе бюджет врёт молча. */
  hasDuration: boolean;
  priority?: ProjectTestPriority;
  status: ProjectTestStatus;
  muted?: boolean;
}

/** Отбор под бюджет: «у меня N минут». */
export interface ProjectTestRiskBudget {
  /** Сколько минут просили. */
  budget: number;
  /** Ключи «группа:кейс», влезшие в бюджет, по убыванию риска. */
  picked: string[];
  /** Что не влезло — с названием и минутами: это и есть честный ответ. */
  left: { key: string; title: string; duration: number }[];
  /** Сумма минут отобранного. */
  minutes: number;
}

/** Риск библиотеки: чем гнать, если времени на всё нет. */
export interface ProjectTestRiskReport {
  /** Кейсы по убыванию риска. */
  items: ProjectTestRiskItem[];
  /** Отбор под бюджет — только когда его спрашивали. */
  budget?: ProjectTestRiskBudget;
  /** Файлы рабочей копии, попавшие в множитель `impact`. */
  changedFiles?: string[];
  checkedAt: string;
}

/** Чем собирается план: правилом, а не агентом. */
export type ProjectTestPlanRecipe =
  /** Дым за N минут: набор под бюджет по приоритету и риску. */
  | 'smoke'
  /** Регрессия по диффу: кейсы, задетые правками, и их соседи по зоне. */
  | 'diff'
  /** План вехи: кейсы требований релиза плюс всё красное с прошлой вехи. */
  | 'release'
  /** Нестабильные: стабильность ниже порога. */
  | 'flaky';

/** Запрос на сборку плана правилом. */
export interface ProjectTestPlanBuildRequest {
  recipe: ProjectTestPlanRecipe;
  /** Бюджет в минутах — у «дыма» обязателен. */
  budget?: number;
  /** Веха — у «плана вехи». */
  release?: string;
  /** Порог стабильности 0–1 — у «нестабильных». */
  threshold?: number;
  environmentId?: string;
  title?: string;
}

/** Кейс, попавший (или не попавший) в собранный план, и почему. */
export interface ProjectTestPlanPick {
  groupId: string;
  caseId: string;
  title: string;
  priority?: ProjectTestPriority;
  /** Ожидаемая длительность, минуты. */
  duration?: number;
  /** Почему взят или почему не влез — строкой для человека. */
  reason: string;
}

/** Предпросмотр плана до сохранения: сколько кейсов, сколько минут, что не влезло. */
export interface ProjectTestPlanPreview {
  recipe: ProjectTestPlanRecipe;
  title: string;
  picked: ProjectTestPlanPick[];
  /** Что НЕ влезло и по какой причине — это и есть ответ на «а что я не проверю». */
  left: ProjectTestPlanPick[];
  /** Сумма минут отобранного. */
  minutes: number;
  /** Бюджет, если он задавался. */
  budget?: number;
}

/**
 * Предложение таксономии: перенести кейсы, не трогая их содержимого.
 *
 * Только `section`/`move` — те же массовые действия, что доступны человеку.
 * Правило, которое правило бы сами кейсы, называлось бы не таксономией, а
 * переписыванием набора.
 */
export interface ProjectTestTaxonomyMove {
  groupId: string;
  caseIds: string[];
  /** Куда внутри группы. */
  section?: string;
  /** Или в какую группу целиком. */
  toGroupId?: string;
  reason: string;
}

/** Разложение набора по секциям — предпросмотр до нажатия. */
export interface ProjectTestTaxonomyPlan {
  moves: ProjectTestTaxonomyMove[];
  /** Сколько кейсов переедет всего. */
  total: number;
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

/**
 * Чем доказаны провалы набора.
 *
 * Считается по самому свежему провалу каждого кейса: провал, доказанный
 * снимком месяц назад и голословный сегодня, — это голословный провал.
 */
export interface ProjectTestEvidenceSummary {
  /** Кейсов с провалом или блокировкой в окне отчёта. */
  failed: number;
  /** Из них с вложением-доказательством. */
  proven: number;
  /** Из них с разобранным провалом: номер шага, ожидание, что вышло. */
  detailed: number;
  /** Провалы, не доказанные ничем, — их и надо перепройти. */
  missing: { groupId: string; caseId: string; title: string }[];
  /** Кейсы, у которых две попытки в одном прогоне разошлись. */
  flaky: { groupId: string; caseId: string; title: string }[];
}

/** Отчёт по истории: тренды, покрытие, нестабильные, деньги и время. */
/**
 * Веха глазами отчёта: сколько прогонов на неё пришлось и сколько кейсов она
 * так и не тронула. Непроверенное — главное число: оно и есть ответ на «можно
 * ли отдавать релиз».
 */
export interface ProjectTestReleaseSummary {
  release: string;
  runs: number;
  passed: number;
  failed: number;
  /** Кейсы, которых не коснулся ни один прогон вехи. */
  untested: number;
  lastRunAt?: string;
}

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
  /** Чем провалы доказаны, и какие не доказаны ничем. */
  evidence: ProjectTestEvidenceSummary;
  /** Вехи от свежей к старой; прогоны без вехи сюда не попадают. */
  releases: ProjectTestReleaseSummary[];
  /** Суммарно по последним прогонам. */
  totals: {
    runs: number;
    tokens: number;
    costUsd: number;
    durationMs: number;
    lastRunAt?: string;
    /** Кейсов в карантине — их провалы в счёт прогона не идут. */
    muted: number;
  };
}

/**
 * Требование глазами вехи: чем оно закрыто и чем кончилось у этой вехи.
 *
 * Состояние считается по прогонам ВЕХИ, а не по текущему статусу кейса: кейс
 * мог позеленеть вчера в другой ветке, и записывать это в готовность релиза
 * значило бы отвечать «отдаём» по проверке, которой в релизе не было.
 */
export interface ProjectTestReleaseRequirement {
  key: string;
  title?: string;
  url?: string;
  /** Статус в трекере, когда он известен. */
  status?: string;
  cases: number;
  passed: number;
  failed: number;
  /** Кейсы требования, которых веха не трогала вовсе. */
  untested: number;
  /** `uncovered` — кейсов нет вообще; `red` — есть провал; `partial` — есть непроверенное. */
  state: 'uncovered' | 'red' | 'partial' | 'covered';
}

/** Кейс в документе готовности: провал, непроверенное или карантин. */
export interface ProjectTestReleaseCase {
  groupId: string;
  caseId: string;
  title: string;
  priority?: ProjectTestPriority;
  /** Результат у этой вехи; `unknown` — веха его не трогала. */
  status: ProjectTestStatus;
  /** Что видел исполнитель — из последнего результата вехи. */
  note?: string;
  muted?: boolean;
  muteReason?: string;
}

/** Незакрытый дефект: адрес, судьба и кейс, из-за которого его завели. */
export interface ProjectTestReleaseDefect {
  url: string;
  title?: string;
  key?: string;
  /** `unknown` — статус у трекера не спрашивали, а не «дефект неизвестен». */
  state: ProjectTestDefectState;
  stateLabel?: string;
  caseId: string;
  groupId: string;
  caseTitle: string;
}

/** Прогон вехи одной строкой — без результатов по кейсам. */
export interface ProjectTestReleaseRun {
  id: string;
  mode: ProjectTestRunMode;
  actor: ProjectTestActor;
  startedAt: string;
  finishedAt?: string;
  branch?: string;
  environmentId?: string;
  summary: ProjectTestRunSummary;
}

/**
 * Вердикт: одна строка, отвечающая на «отдаём или нет».
 *
 * Панель НЕ решает за человека и не подписывает релиз: `ready` — это ответ
 * «ничего из перечисленного не мешает», а не разрешение. Всё, что мешает,
 * названо поимённо в `blockers` — вердикт без причин был бы приговором.
 */
export interface ProjectTestReleaseVerdict {
  ready: boolean;
  text: string;
  blockers: string[];
}

/**
 * Готовность вехи одним документом.
 *
 * Ради этого документа раздел и заводился: ответ на «отдаём или нет» сегодня
 * собирается из четырёх вкладок, и каждый собирает его по-своему. Порядок
 * разделов здесь — порядок чтения: сначала то, что мешает (непроверенное и
 * открытые дефекты), потом чем это доказано.
 */
export interface ProjectTestReleaseDocument {
  release: string;
  /** Когда документ собран, ISO: он собирается на лету и не хранится. */
  generatedAt: string;
  branch?: string;
  commit?: string;
  verdict: ProjectTestReleaseVerdict;
  totals: {
    /** Живых кейсов в наборе — вместе с теми, которых веха не трогала. */
    cases: number;
    passed: number;
    failed: number;
    blocked: number;
    skipped: number;
    untested: number;
    /** Кейсов в карантине: их провалы вердикт не красят, но названы вслух. */
    muted: number;
    runs: number;
  };
  requirements: ProjectTestReleaseRequirement[];
  /** Провалы и блокировки вехи — от важного к остальному. */
  red: ProjectTestReleaseCase[];
  /** Кейсы, которых не коснулся ни один прогон вехи. */
  untested: ProjectTestReleaseCase[];
  /** Красное, снятое карантином: провал есть, а вердикт он не красит. */
  muted: ProjectTestReleaseCase[];
  /** Незакрытые дефекты живых кейсов. */
  defects: ProjectTestReleaseDefect[];
  runs: ProjectTestReleaseRun[];
  /** Почему часть документа неполна — Atlassian выключен, Jira молчала. */
  warning?: string;
}

/**
 * Сломанный файл обвязки — окружения, общие шаги, свои поля, сохранённые виды.
 *
 * Читаются они щадяще (сломанный файл = пустой список, а не красный раздел), и
 * до окна настроек этого хватало: пустой список никого не обманывал. С окном,
 * из которого их ЗАВОДЯТ, молчание стало опасным — человек видит «окружений
 * нет», добавляет своё, и запись целиком стирает файл, который кто-то писал
 * руками. Поэтому причина едет на экран, а запись в такой файл запрещена.
 */
export interface ProjectTestLibraryIssue {
  /** Файл от корня проекта: `.agent/tests/environments.json`. */
  file: string;
  error: string;
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
  /** Файлы обвязки, которые не прочитались. Пусто — все на месте. */
  libraryIssues?: ProjectTestLibraryIssue[];
  /**
   * Черновики генерации, ждущие приёмки. Приезжают вместе с видом, а не
   * отдельным запросом: вкладка «Библиотека» опрашивает вид и так, а
   * непринятое предложение — это то, ради чего человек сюда и вернулся.
   */
  drafts: ProjectTestDraftSummary[];
  /** Галочка «принимать сразу» для этого проекта — память панели, не файл проекта. */
  autoAcceptDrafts: boolean;
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
  /**
   * Шаги приходят объектами; строки тоже принимаются и достраиваются.
   *
   * Поля НЕТ — «не трогай»: правка сводится с диском по `id`, и запрос, который
   * про шаги ничего не сказал (кнопка «в архив», смена приоритета, правка с
   * телефона), не имеет права их стереть. Пустой список — это «очисти».
   */
  steps?: (ProjectTestStep | string)[];
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
  /** Порог расхождения эталонного скриншота, доля пикселей 0–1. */
  maxDiffRatio?: number;
  status?: ProjectTestStatus;
  statusId?: string;
  /** Карантин: провал кейса известен и не красит прогон. */
  muted?: boolean;
  muteReason?: string;
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
    /** В карантин: провалы перестают красить прогон. Значение — причина. */
    | 'mute'
    | 'unmute'
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
  /** Веха, к которой отнести прогон; пусто — снять с тега git, если он есть. */
  release?: string;
  /**
   * Принимать черновик генерации сразу, без просмотра.
   *
   * По умолчанию выключено: генерация приезжает предложением, а библиотеку
   * меняет человек. Права прогона от этой галочки НЕ меняются — файлы групп
   * пишет панель в любом случае.
   */
  autoAccept?: boolean;
  /** Откуда генерация берёт материал; пусто — по коду проекта. */
  source?: ProjectTestGenerateSource;
  /** Требование или дефект: ключ задачи либо ссылка на неё. */
  sourceRef?: string;
  /** Диапазон сравнения для источника «дифф»; пусто — `origin/main..HEAD`. */
  diffRange?: string;
  /** Провал, из которого заводится регрессионный кейс. */
  sourceCase?: { groupId: string; caseId: string; runId?: string };
}

/**
 * Откуда генерация берёт материал.
 *
 * «По коду» отвечает на «что тут вообще есть», но в работе спрашивают другое:
 * покрыть требование, проверить изменённое в ветке, закрепить починенный баг.
 * Это разные задания одному и тому же прогону, а не разные режимы.
 */
export type ProjectTestGenerateSource = 'code' | 'requirement' | 'diff' | 'defect';

/** Материал источника: то, что панель собрала для задания генерации. */
export interface ProjectTestGenerateMaterial {
  source: ProjectTestGenerateSource;
  /** Требование: ключ, ссылка и текст задачи, если его удалось прочитать. */
  requirement?: { key: string; url: string; title: string; description?: string };
  /** Дифф: что сравнивали, какие файлы задеты и краткая сводка. */
  diff?: { range: string; files: string[]; summary?: string };
  /** Провал: кейс, его шаги и то, что увидел исполнитель. */
  defect?: {
    groupId: string;
    caseId: string;
    title: string;
    steps: string[];
    note?: string;
    attachments: string[];
    url?: string;
  };
}

/** Кейс в матрице покрытия: чем требование проверено и чем это кончилось. */
export interface ProjectTestCoverageCase {
  groupId: string;
  caseId: string;
  title: string;
  status: ProjectTestStatus;
  muted?: boolean;
  lastRunAt?: string;
}

/**
 * Одно требование и всё, что его проверяет.
 *
 * Ключ — то, чем требование названо в ссылке кейса: ключ задачи Jira (`QA-42`)
 * или адрес, если ключа из него не вывести. Требование без единого кейса
 * остаётся в списке с пустым `cases` — оно и есть ответ на вопрос, ради
 * которого матрицу открывают.
 */
export interface ProjectTestCoverageItem {
  key: string;
  url?: string;
  title?: string;
  /** Статус требования в трекере, если про него спрашивали. */
  status?: string;
  cases: ProjectTestCoverageCase[];
  counts: { passed: number; failed: number; blocked: number; skipped: number; unknown: number };
}

/** Матрица покрытия: требования → кейсы → последний результат. */
export interface ProjectTestCoverage {
  items: ProjectTestCoverageItem[];
  /** Кейсы, не привязанные ни к одному требованию. */
  orphans: ProjectTestCoverageCase[];
  /**
   * Откуда взят список требований: только из ссылок кейсов или ещё и из Jira.
   * От этого зависит смысл пустого `cases` — без Jira панель просто не знает о
   * требованиях, на которые никто не сослался.
   */
  source: 'links' | 'jira';
  /** Запрос, которым требования брались из Jira. */
  jql?: string;
  /** Почему список требований неполон: интеграция выключена, Jira не ответила. */
  warning?: string;
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
