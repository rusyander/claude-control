import type {
  HumanAskSource,
  JournalDataV1,
  REQUIREMENT_SOURCES,
  RequirementVerdict,
  STEP_END_BASES,
} from '@agentdeck/contracts/core/journal';
import type { BoardStop } from '@agentdeck/contracts/core/board';
import type { ScenarioRef, TaskClass } from '@agentdeck/contracts/core/scenario';
import type {
  AskState,
  CheckRunState,
  PublishState,
  SessionState,
  StepState,
  TaskState as TaskMachineState,
  UnitState,
} from '@agentdeck/contracts/core/states';

/**
 * Состояние задачи = свёртка журнала (01 §State). Ничего здесь не хранится иначе как через
 * событие; снимок — производный и пересобирается из журнала.
 */

/** Меняется, когда меняется форма состояния: снимок другой версии не используется. */
// 2: `CommandRecord.bodyHash` (ревью M1) — снимки версии 1 его не несут, открытие идёт полным проходом.
// 3: `StepRecord.claim` из `step.claimed`.
// 4: `CommandRecord.masked` (ревью F-25); повторное create-событие — аномалия, запись не
//    трогается (ревью F-52).
// 5: `CheckRunRecord.run` из `check.requested` и `recordId` из `check.recorded` (G24).
// 6: этап 4 (CD§10): сценарий, требования, деления, круги и напоминания шага, вопросы с
//    источником, правки, доставки, допуски, отчёт, пауза «сейчас».
// 7: этап 5 (план s5 §1): расход по ходам (замена по messageId, остатки, подагенты), окно на пару
//    «маршрут × вид предела», бюджеты по областям, отданные секции вводной, замеры базы.
// 8: этап 6 (публикатор): публикация по единице (собранное, MR, чтение, CI, ожидание форжа,
//    «опубликовать сейчас»), закрытие копий и ссылки удалённого стража; единица действия.
// 9: этап 7 (слой пользователя): последний хеш слоя человека по CLI из `layer.changed`.
// 10: этап 8 (наблюдатель): подсказки и просьба о паузе по сессии из `signal{action}`, решения
//     наблюдателя с подсказкой, ждущие своей строки сигнала.
// 11: этап 8 (закрытие): шаг, чья сессия кончилась при просьбе наблюдателя о паузе, до повтора.
// 12: этап 11 (ведущий): принятая карточка приёма и класс задачи (`lead`).
// 13: этап 11: утверждение деления человеком после `accepted` / `edited` — `approved`, не аномалия
//     (снимок v12 держит такое деление в `accepted`).
// 14: этап 12 (доска): действие по умолчанию вопроса (`AskRecord.defaultAction`, «ждёт вас»),
//     остановка задачи, перехват и возврат, потеря входа маршрута, конец MR единицы.
export const REDUCER_VERSION = 14;

/**
 * Состояния задачи, в которых идёт работа (паузы, ожидание человека и окна не считаются). Здесь,
 * а не в свёртке: хвост рабочего времени исполнителя (`workNow`) считает по тому же списку, а
 * свёртку импортирует только `resume()`.
 */
export const WORKING: readonly TaskMachineState[] = ['estimating', 'running', 'publishing'];

/**
 * Прогон проверки в свёртке (G24): после краха возобновить или снять его можно, только зная, что
 * это за прогон, — проверка, единица, ключ. `run` нет у прогона, начатого одним переходом без
 * `check.requested` (журналы до этапа 3): такой виден, но возобновлению не подлежит.
 */
export interface CheckRunRecord {
  state: CheckRunState;
  run?: JournalDataV1['check.requested'];
  recordId?: string;
}

export interface ActionRecord {
  kind: JournalDataV1['action.started']['kind'];
  target: string;
  idempotencyHint: string;
  /** `awaiting-human` — сверка не узнала исход и задала вопрос (точка 4). */
  status: 'started' | 'awaiting-human' | 'done' | 'failed';
  startedSeq: number;
  startedAt: number;
  code?: string;
  /** Единица, от имени которой начато действие (`action.started.unitId`): публикатор ищет своё. */
  unitId?: string;
}

export interface CommandRecord {
  kind: string;
  status: 'received' | 'applied' | 'rejected';
  receivedSeq: number;
  /** Только у паузы (G10): `now` — остановка дерева сразу, иначе в безопасной точке. */
  now?: boolean;
  /** Доказательство приёма — по нему решает и ядро, принявшее команду до краха. */
  proof: JournalDataV1['command.received']['proof'];
  /** Отпечаток принятого тела (`command-body.ts`): повтор `cmdId` с другим телом — отказ. */
  bodyHash: string;
  /**
   * Тело легло в журнал с маской DLP (`masked` строки > 0): `bodyHash` посчитан по
   * маскированному телу, и повтор сравнивается с ним только через ту же маску (ревью F-25).
   */
  masked?: boolean;
  outcomeSeq?: number;
  code?: string;
  reason?: string;
  outcome?: unknown;
}

export interface StepRecord extends StepExtra {
  state: StepState;
  unitId: string;
  stepKind: string;
  /** Последнее принятое заявление `step_done` (`step.claimed`) и номер его строки. */
  claim?: { seq: number; call: JournalDataV1['step.claimed']['claim'] };
}

/** Чем шаг прирос на этапе 4 (CD§10 `stepExtra` + то, что нужно `conductor/next`). */
export interface StepExtra {
  stepDefId: string;
  round: number;
  /** Строка `step.started`: порядок попыток одного шага сценария (ревью ⇄ правка, G14). */
  startedSeq: number;
  /** Срок шага (мс рабочего времени); продление `budget.state` его поднимает. 0 — без срока. */
  budgetMs: number;
  /** Рабочее время задачи на старте шага: потрачено = `work.activeMs` − это (01 §Time). */
  workAtStart: number;
  /** Сколько раз срок продлён (`once-more` или ответ на точку 7). */
  extensions: number;
  reminders: number;
  remindedTurns: number[];
  /** Красная проверка после заявления (`checked-red`): её строка — шаг ждёт повтора (G14). */
  red?: { seq: number };
  /** `step.ended`: исход, на чём стоит и почему. */
  outcome?: JournalDataV1['step.ended']['outcome'];
  basis?: (typeof STEP_END_BASES)[number];
  reason?: string;
  /** Сигналы `stop` по шагу (защищённые корни, F-061): шаг останавливается, не повторяется. */
  stops: string[];
}

export interface UnitRecord {
  state: UnitState;
  branch: string;
  name: string;
  repoKey: string;
  ownedPaths: string[];
  after: string[];
  contract: boolean;
  splitId: string | null;
  createdSeq: number;
  /** Этап 11 (P137, W3-18b): роль куска плана (`unit.created.role`); `integrate` — единица интеграции. */
  role?: JournalDataV1['unit.created']['role'];
}

export interface AskRecord {
  state: AskState;
  point: number;
  source: HumanAskSource;
  dedupe: string | null;
  stepId: string | null;
  /** Ответ пришёл после истечения или отзыва вопроса (P71): хранится и показан. */
  lateAnswer: boolean;
  answer?: string;
  /** Этап 12 (P153): из `human.asked`; `null` — вопрос блокирует, задача «ждёт вас». */
  defaultAction: string | null;
}

export interface SessionRecord {
  state: SessionState;
  stepId: string;
  adapter: string;
  route: JournalDataV1['session.started']['route'];
  /** `null` — модель по умолчанию CLI (`--model` не передан). */
  modelAsked: string | null;
  modelServed: string | null;
  hostPid: number;
  hostStart: string;
  cliPid: number | null;
  cliStart: string | null;
  /**
   * Подсказки наблюдателя, ещё не доставленные модели (сигналы с `action: 'hint'`, F8): дирижёр
   * шлёт их пачкой в конце хода. `seq` — строка решения (`cause` сигнала); доставка
   * `message.delivered{kind:'hint', id}` снимает подсказку с этим решением и все прежние.
   */
  hints: SessionHint[];
  /**
   * Наблюдатель просит паузу в безопасной точке (`action: 'pause-at-safe-point'`): сессию
   * паркуют на границе хода. Снимается её концом (`ended`/`lost`).
   */
  parkAsked: { signal: string; seq: number } | null;
}

export interface SessionHint {
  decisionId: string;
  seq: number;
  signal: string;
  /** Предмет сигнала (путь, argv): по нему каталог строит текст подсказки. */
  subject: string;
  detail: string;
}

export interface TaskFoldState extends TaskFoldStage4, TaskFoldStage5, TaskFoldPublish {
  reducer: number;
  taskId: string;
  seq: number;
  lastAt: number | null;
  created: JournalDataV1['task.created'] | null;
  task: TaskMachineState;
  ended: JournalDataV1['task.ended']['outcome'] | null;
  units: Record<string, UnitRecord>;
  steps: Record<string, StepRecord>;
  sessions: Record<string, SessionRecord>;
  checks: Record<string, CheckRunRecord>;
  asks: Record<string, AskRecord>;
  publish: Record<string, { state: PublishState }>;
  actions: Record<string, ActionRecord>;
  commands: Record<string, CommandRecord>;
  resources: Record<string, { kind: string; status: 'live' | 'released' | 'verified' | 'leak' }>;
  lease: { leaseId: string | null; takeovers: number };
  counters: { masked: number; repairedBytes: number; errors: number; clockJumps: number };
  /** Рабочее время по `mono` одной загрузки, без пауз, ожиданий и сна (01 §Time, P56). */
  work: { activeMs: number; lastMono: number | null; lastBootId: string | null };
  /** Событие, противоречащее машине состояний: показано, не применено. */
  anomalies: { seq: number; reason: string }[];
  /**
   * Последний `layer.changed` по CLI (переходник сессии строки): дорога сравнивает с ним опись
   * нового сеанса. Из журнала, а не из памяти процесса — перезапуск ядра не пишет смену заново.
   */
  layerHashes: Record<string, string>;
  /**
   * Этап 11 (W2-6, W2-8): ведение задачи — принятая карточка приёма (`intake.card`) и последний
   * класс (`decision` класса `classify`). Нет поля — задача ни того, ни другого не писала
   * (необязательное: свёртки до v12 его не знают, `initialState` его не заводит).
   */
  lead?: {
    card: { by: 'auto' | 'human'; seq: number } | null;
    taskClass: { class: TaskClass; seq: number } | null;
  };
  /**
   * Этап 12 (свёртка v14, `stage12.ts`): последний `task.stop`. Нет поля — остановку не меняли;
   * действующую читает `boardStopOf` (поверх `created.boardEntry`). Все поля этапа 12
   * необязательные: `initialState` их не заводит, свёртки до v14 их не знают.
   */
  stop?: { stop: BoardStop; seq: number };
  /** Открытый перехват (`task.takeover`); `null` — закрыт возвратом. Нет поля — не было ни одного. */
  takeover?: { unitId: string; copy: string; seq: number; chatTaskId?: string } | null;
  /** Последний возврат ядру (`task.handback`): заметка человека уходит в бриф следующего шага. */
  handback?: { note: string | null; seq: number };
  /** Потеря входа маршрута по шагу (`route.login-lost`). */
  loginLost?: Record<string, { routeId: string; seq: number }>;
}

/** Требование в свёртке (CD§10): вердикт выносит только `conductor/requirements` (02:57). */
export interface RequirementFold {
  ordinal: number;
  text: string;
  source: (typeof REQUIREMENT_SOURCES)[number];
  verdict: RequirementVerdict;
  evidence: string[];
}

/**
 * Поля свёртки v6 этапа 4 (CD§10), влитые в `TaskFoldState`; шаг, единица и вопрос приросли
 * своими (`StepExtra`, `UnitRecord`, `AskRecord`).
 */
export interface TaskFoldStage4 {
  scenario: {
    ref: ScenarioRef;
    pending: { to: ScenarioRef; applyNow: boolean } | null;
    rejected: number;
  } | null;
  requirements: Record<string, RequirementFold>;
  /** Последний `requirement.reviewed`: null — сверки не было, ворота закрыты (P93). */
  extractionReview: { complete: boolean; seq: number } | null;
  splits: Record<
    string,
    {
      state: 'proposed' | JournalDataV1['split.decided']['outcome'];
      by: JournalDataV1['split.proposed']['by'];
      /** Единицы деления в порядке `unit.created` с этим `splitId` (зона D читает отсюда). */
      units: string[];
    }
  >;
  overrides: ({ seq: number } & Omit<JournalDataV1['override.set'], 'cmdId'>)[];
  /** По id ссылки (cmdId / askId): доставлено один раз (F26). */
  deliveries: Record<string, { stepId: string; seq: number }>;
  grants: Omit<JournalDataV1['grant.given'], 'cmdId'>[];
  report: { seq: number; at: JournalDataV1['report.final']['at'] } | null;
  /** Последняя принятая пауза (G10): `now` — остановка дерева сразу; снята продолжением. */
  pause: { seq: number; now: boolean } | null;
  /**
   * Решения наблюдателя с действием `hint` по своей строке (seq → decisionId), пока не пришёл их
   * сигнал (`cause` = эта строка): подсказке нужен decisionId, а в строке сигнала его нет.
   */
  hintDecisions: Record<string, string>;
  /**
   * Шаги (по stepId), чья сессия кончилась, пока наблюдатель просил паузу (`parkAsked` при
   * переходе в конечное состояние): повтор шага пишет `continuation` с причиной наблюдателя (F10).
   * В свёртке, а не в памяти процесса: перезапуск ядра между просьбой и повтором её не теряет.
   * Снимается строкой `tier`/`continuation` этого шага или новой сессией шага.
   */
  observerParks: Record<string, { signal: string; seq: number; sessionId: string }>;
}

/** Сумма расхода в токенах; деньги — отдельным фактом цены, не здесь (P127). */
export interface UsageTotals {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
  output: number;
  /** Ходов модели (строк `turn.usage` без остатков). */
  turns: number;
}

/**
 * Поля свёртки v7 этапа 5 (план s5 §1), влитые в `TaskFoldState`; тело — `stage5.ts`, чтение —
 * `fold-view.ts` (`usageOf`, `windowOf`, `sentOf`).
 */
export interface TaskFoldStage5 {
  usage: {
    task: UsageTotals;
    bySession: Record<string, UsageTotals>;
    byStep: Record<string, UsageTotals>;
    /** Подагенты отдельно: они же входят в сессию-родителя (`parentSessionId`). */
    subagents: UsageTotals;
    /**
     * Последняя строка по ключу `<sessionId>|<messageId>`: повтор ЗАМЕНЯЕТ прежнюю, а не
     * прибавляется (ход собирается по частям, max-merge в переходнике; хост сессии после
     * переподключения отдаёт поток заново).
     */
    lastByMessage: Record<string, JournalDataV1['turn.usage']>;
  };
  /** Последний `window.state` на пару «маршрут × вид предела» (ключ `<routeId>|<limitKind>`). */
  windows: Record<string, JournalDataV1['window.state'] & { seq: number }>;
  /** Последний `budget.state` по области. */
  budgets: Record<string, JournalDataV1['budget.state'] & { seq: number }>;
  /** Отданные сеансу секции вводной: id секции → sha256 (дельта шлёт только изменённые). */
  sent: Record<string, Record<string, string>>;
  /** Замеры базового контекста этой задачи (G9), по порядку. */
  bases: JournalDataV1['context.base'][];
  /** Последний `routes.set`: он, а не `task.created`, держит разрешённый набор (`allowedRoutesOf`). */
  routesSet: (JournalDataV1['routes.set'] & { seq: number }) | null;
}

/** Публикация одной единицы в свёртке (этап 6): тело — `publish.ts`, чтение — публикатор и `next`. */
export interface UnitPublication {
  /** Последний `publish.composed`: дерево и коммиты, которые ушли бы сейчас (P67). */
  composed: (JournalDataV1['publish.composed'] & { seq: number }) | null;
  /** Личность MR — первый `publish.mr` единицы; другой id позже — аномалия, не замена (P31). */
  mr: (JournalDataV1['publish.mr'] & { seq: number }) | null;
  /** Нити и конфликт — первое и единственное чтение при открытии MR (05 §After publish). */
  read: (JournalDataV1['publish.read'] & { seq: number }) | null;
  /** Последнее чтение CI (только при живом решении ждать CI этой задачи, P64). */
  ci: (JournalDataV1['publish.ci'] & { seq: number }) | null;
  /** Последний цикл ожидания форжа этой единицы; `at` — стена строки (срок считается от неё). */
  backoff: (JournalDataV1['publish.backoff'] & { seq: number; at: number }) | null;
  /** seq применённой команды `publish-now` по этой единице (P96: ни вопроса, ни условия не снимает). */
  publishNowSeq: number | null;
  /** Этап 12: конец MR у форжа (`publish.mr-state`); нет поля — MR открыт или его нет. */
  mrState?: JournalDataV1['publish.mr-state'] & { seq: number };
}

/**
 * Поля свёртки v8 этапа 6 (публикатор), влитые в `TaskFoldState`; тело — `publish.ts`. Закрытие
 * и ссылки удалённого — базы сверки стража (G), публикатор их не читает.
 */
export interface TaskFoldPublish {
  publication: Record<string, UnitPublication>;
  closures: Record<string, JournalDataV1['publish.closure'] & { seq: number }>;
  /** Последний `publish.remote-refs` по удалённому, ключ `remoteRefsKey(repoKey, remote)`. */
  remoteRefs: Record<string, JournalDataV1['publish.remote-refs'] & { seq: number }>;
}
