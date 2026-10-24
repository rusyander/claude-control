import {
  applySplitPlan,
  scanSplitPlanBlocks,
  triageStagePrompt,
  type PredecessorNote,
  type SplitPlan,
  type TriageGroupCatalogEntry,
} from '@agentdeck/contracts/split-plan';
import { safeBranchName, type TaskSplitResult } from '@agentdeck/contracts/task-split';
import { parseForeignChatKey } from '@agentdeck/contracts/foreign-chat-key';
import {
  mergeSplitHumanSteps,
  mergeSplitTickets,
  splitTicketKey,
  type SplitHumanStepProposal,
  type SplitTicketProposal,
  type SplitTicketView,
} from '@agentdeck/contracts/split-tickets';
import {
  splitPlanRunning,
  type SplitGroupCleaned,
  type SplitGroupKeepWarm,
  type SplitGroupRechecked,
  type SplitPlanView,
} from '@agentdeck/contracts/chat-handoff';
import {
  LEARN_SIEVES_LINE,
  mergeSieveRows,
  SIEVE_REPORT_LINE,
  type LearnedSieveRow,
  type SieveClass,
  type SieveReportRow,
} from '@agentdeck/contracts/sieves';
import type {
  ChatLink,
  SplitPlanGroupRecord,
  SplitPlanRecord,
  SplitTokenFlag,
  SplitReviewClose,
  SplitTokenLedger,
} from '../../../lib/app-store/app-store.types.ts';
import { coldStartMedian, tokenFlags } from '../token-ledger/token-ledger.ts';
import type { ChatEvent } from '../ChatRunner/ChatRunner.ts';
import type { RunFinished } from '../ChatRunRegistry/ChatRunRegistry.ts';
import type { SplitGroupContext } from '../ChatSplit/ChatSplit.ts';
import { coded } from '../../../lib/server-text/server-text.ts';
import { maskSecretsInText } from '../../../lib/secret-mask/secret-mask.ts';
import type { GroupTestsVerdict } from '../tests-gate/tests-gate.ts';
import type { MrReviewThread } from '../../integrations/mr-review/mr-review.ts';
import { noteRelayed, REVIEW_REPLY_LINES } from '../mr-watch/review-threads.ts';
import { normalizePath } from '../../project-runner/targets.ts';
import { localizeText, matchText, serverText } from '../../../lib/server-texts/server-texts.ts';
import { ownerCoverageGaps } from '../owner-coverage/owner-coverage.ts';
import { hasOwnerRequest } from '@agentdeck/contracts/quality-floor';
import { groupSignalsOf, type GroupSignal } from '@agentdeck/contracts/group-watch';
import {
  deliveryIncompleteText,
  deliveryMissingCodesOf,
  errorCodeOf,
} from '../split-group-texts.ts';
import { groupIdentityLine } from '../panel-preamble.ts';
import { trackerKeys } from '../tracker-keys.ts';
import { SplitTicketMarks, type TicketFiling } from '../split-ticket-batch/ticket-marks.ts';
import { groupTaskKeys } from '../split-tasks/split-tasks.ts';
import {
  continuable,
  continuePrompt,
  HUMAN_ONLY_LINE,
  type HumanAskKind,
} from '../split-continue.ts';

/**
 * Конвейер уровней разделения (Т1): разбор ПЕРЕД копиями, порции запуска
 * ПОСЛЕ разбора, ожидание предшественников и ответа человека.
 *
 * До него разделение было одним запросом: копии, связи, прогоны — и всё. Теперь
 * между согласием человека и первым прогоном группы стоит разбор на потолке,
 * который видит все группы и код, а группы стартуют не разом, а по его итогу:
 * без ожиданий — сразу, с `after` — когда кончится цепочка предшественников
 * (их копия ветвится ОТ той ветки), с `hold` — когда ответит человек.
 *
 * Три правила.
 *
 * 1. НИЧЕГО НЕ БЛОКИРУЕТ. Разбор не дал блока, упал, не стартовал — группы
 *    заводятся, как заводились бы без него; лента говорит «разбор не получен».
 *    Панель не заставляет человека ждать умную модель ради того, что и так бы
 *    поехало.
 * 2. ПАМЯТЬ — В ХРАНИЛИЩЕ. Разбор идёт минуты, ожидания — часы, и стенд за это
 *    время перезапускается (см. Т4). Всё, что нужно для порции запуска, лежит в
 *    `SplitPlanRecord`, и после рестарта конвейер продолжает с той же записи.
 * 3. ЗАПУСК — СНАРУЖИ. Домен не знает ни git, ни реестра прогонов: копии и
 *    прогоны заводит колбэк маршрута (`launch`), разбор — `startTriage`. Так
 *    всё это проверяется тестами без единого настоящего прогона.
 */

export interface SplitConveyorStore {
  get(parentChatId: string): SplitPlanRecord | undefined;
  set(record: SplitPlanRecord): void;
  findByTriage(chatIds: readonly string[]): SplitPlanRecord | undefined;
  all(): Record<string, SplitPlanRecord>;
  /**
   * Сигналы сторожа группы — свой срез хранилища (F-42), только для вида:
   * конвейер их не пишет, и его запись после `await` их не сотрёт.
   */
  watchSignals?(parentChatId: string, groupIndex: number): unknown;
  /**
   * Счёт пингов тёплого кэша группы — свой файл учёта пингов, только для вида:
   * проводка пинга не пишет запись плана и не гоняется с конвейером за неё.
   */
  keepWarm?(parentChatId: string, groupIndex: number): SplitGroupKeepWarm | undefined;
}

export interface SplitConveyorDeps {
  store: SplitConveyorStore;
  /** Фоновые команды живого процесса разговора группы — что убьёт пауза (L7.6). */
  backgroundTasks?: (chatId: string) => readonly string[];
  /**
   * Проект трекера для тикетов групп по пути проекта: привязан и интеграция
   * подключена. Нет зависимости или ответа — завести тикет из хаба нельзя.
   */
  ticketTracker?: (projectPath: string) => string | undefined;
  /** Jira подключена — хаб предлагает «Перевести задачи» групп с MR (G4). */
  tasksConnected?: () => boolean;
  /**
   * Завести копии и запустить ПЛАН для групп записи (индексы). Одна порция —
   * один контекст: от какой ветки отводить и что группы знают о предшественниках.
   *
   * `claimBranch` зовётся, как только у группы появилось НАСТОЯЩЕЕ имя ветки, и
   * ДО старта её прогона — той же причины, что и `claim` у `startTriage`:
   * занятое имя получает суффикс (`feature/auth-2`), а цепочка группы может
   * кончиться раньше, чем вернётся вся порция. Конец цепочки ищет группу по
   * ветке, и без этого вызова он искал бы по имени, которого в git нет: группа
   * не закрывалась бы никогда, а её преемники с `after` стояли бы вечно.
   */
  launch: (
    record: SplitPlanRecord,
    groups: number[],
    context: SplitGroupContext | undefined,
    claimBranch: (index: number, branch: string, path?: string) => void,
    /**
     * Спрашивается после подготовки копий, прямо перед стартом прогона: группа
     * всё ещё «стартует»? Пауза или отмена за время `npm ci` — нет (живой прогон 29.09).
     */
    startable?: (index: number) => boolean,
  ) => Promise<TaskSplitResult>;
  /**
   * Запустить разбор (уровень 1); `deferred` — дерево на паузе, старт отложен.
   *
   * `claim` зовётся, как только у разговора появился ключ, и ДО его запуска.
   * Иначе разбор, ответивший мгновенно (у чужого CLI это обычное дело — прогон
   * может кончиться ошибкой на первом же вздохе), искал бы свою запись в
   * хранилище раньше, чем она туда попала, и его итог пропал бы молча.
   */
  startTriage: (
    record: SplitPlanRecord,
    prompt: string,
    claim: (chatId: string) => void,
  ) => { chatId: string; started: boolean; deferred: boolean };
  /**
   * Цепочка группы кончилась — самое время сверить ветки (Т6): работа легла, и
   * пересечение с соседями теперь факт, а не прогноз. Не задан — сверки нет, всё
   * остальное работает как раньше.
   */
  watchOverlap?: (parentChatId: string) => void;
  /**
   * Счёт токенов группы (E4): цепочка кончилась, транскрипты её звеньев полны.
   * Не задан — карточки нет, всё остальное как раньше.
   */
  tokenLedger?: (
    record: SplitPlanRecord,
    group: SplitPlanGroupRecord,
    provider: string,
  ) => Promise<SplitTokenLedger | undefined>;
  /**
   * Закрытие группы ревью по её копии (T13, T6/T11): что осталось в копии, какие
   * временные копии убраны, снята ли одноразовая база. Не задан — группа
   * закрывается как раньше, без итога.
   */
  closeReview?: (
    record: SplitPlanRecord,
    group: SplitPlanGroupRecord,
    options: { dirt: boolean },
  ) => Promise<SplitReviewClose | undefined>;
  /**
   * Сколько групп разделения работает одновременно (настройка проекта). Не
   * задан — без ограничения. Сверх него готовые группы ждут в очереди
   * (`pending`) и стартуют, как только у работающей кончится ход.
   */
  parallel?: (record: SplitPlanRecord) => number;
  /**
   * Доставка по фактам git: группа с доставкой закрывается `done` только
   * тогда, когда дерево чистое, ветка отправлена и есть MR с её головой. Не
   * задан — «готово» по концу хода, как раньше.
   */
  delivery?: SplitDeliveryDeps;
  /**
   * Есть ли в копии правки с момента `since` — незакоммиченные или коммиты.
   * Итог хода меряет правки от начала ПОСЛЕДНЕГО звена, а у группы их бывает
   * несколько (продолжение, ревью); «без правок» сверяется со стартом группы.
   */
  hasWork?: (cwd: string, since?: string) => boolean;
  /**
   * Продолжить разговор группы словом панели — тем же каналом, что слово
   * родителя (Д7). Нужен оборванной группе (WP1c); не задан — она ждёт кнопки.
   */
  resume?: (group: SplitPlanGroupRecord, prompt: string) => 'sent' | 'queued' | 'refused';
  /**
   * Слово «Перепроверить MR» — новым разговором группы с вводной (R2/R5, 19.10:
   * продолжение после часов простоя — промах кэша и давние нити контекста).
   * Не задан — продолжением сессии, как любое слово панели (`resume`).
   */
  recheck?: (
    record: SplitPlanRecord,
    group: SplitPlanGroupRecord,
    prompt: string,
  ) => 'sent' | 'queued' | 'refused';
  /**
   * Таймер ожидания сброса лимита (журнал 89). Сам срок лежит в записи, таймер
   * только будит; не задан — `setTimeout`.
   */
  schedule?: (run: () => void, ms: number) => unknown;
  /** Заметка в ленту родителя (лимит подписки); не задана — хаб покажет и так. */
  notify?: (parentChatId: string, event: ChatEvent) => void;
  /**
   * Группы панели, из которых разбор выбирает группу каждой группе разделения
   * (выбор группы родителя — `auto`). `undefined` — разбор не выбирает: у
   * родителя явная группа или выбирать не из чего. Не задан — выбора нет вовсе.
   */
  groupCatalog?: (
    record: Pick<SplitPlanRecord, 'parentChatId' | 'projectPath'>,
  ) => TriageGroupCatalogEntry[] | undefined;
  /**
   * Сита перед MR (решение владельца 28.09): приём выученных по тредам MR и
   * счёт пойманных до MR. Нет — конвейер работает без обучения.
   */
  sieves?: {
    learn: (input: {
      rows: readonly LearnedSieveRow[];
      relayed: readonly string[];
      projectPath: string;
      mr?: string;
    }) => { accepted: unknown[]; rejected: unknown[] };
    caught: (classes: readonly SieveClass[]) => void;
  };
  log: (message: string, error?: unknown) => void;
  now?: () => Date;
}

/** Чего не хватило до доставки группы — по фактам git (`delivery-facts.ts`). */
export interface DeliveryVerdict {
  /** Строки «не хватает: …»; пусто — доставлено. */
  missing: string[];
  /** MR, чья голова — HEAD копии группы. */
  mr?: string;
  /** Удалённый не ответил: факт неизвестен, а не отрицателен. */
  unreachable?: string;
  /** Описание MR не прочитать (фордж выключен, нет токена) — сказать человеку. */
  descriptionUnchecked?: boolean;
  /**
   * Классы сит, которые сработали на этой проверке (механика панели или сито,
   * сданное «fail»): блокер пойман до MR — в счёт панели, раз на группу.
   */
  sieveClasses?: SieveClass[];
  /**
   * Сама копия не читается (status/rev-parse упали локально): ждать тут нечего,
   * сеть ни при чём — группа закрывается сбоем с причиной (m5).
   */
  failed?: string;
  /** Ветка, которую группа завела и отправила сама вместо названной панелью. */
  branch?: string;
  /** Вердикт блока «Тесты» копии: задетые кейсы и их итог в прогонах группы. */
  tests?: GroupTestsVerdict;
  /**
   * Ветки ревьюера без ответа, ушедшие пробелом: дошедшее слово отмечает их
   * переданными (`mrWatch`), и сито, выученное из них, принимается.
   */
  reviewThreads?: MrReviewThread[];
  /**
   * Заметки, а не пробелы (решение владельца 23.10): живое сито «не
   * проверено», красное не из-за ветки. Группу не держат — карточке и MR.
   */
  notes?: string[];
  /** HEAD копии на этой проверке: по нему видно, двигалась ли группа между напоминаниями. */
  head?: string;
}

export interface SplitDeliveryDeps {
  facts: (
    group: SplitPlanGroupRecord,
    mrHint: string | undefined,
    projectPath: string,
    /** Ветки других групп плана и основания копий — не своя ветка группы. */
    claimed: string[],
  ) => Promise<DeliveryVerdict>;
  /**
   * Продолжить разговор группы сообщением панели — тем же путём, что слово
   * родителя (Д7): занятая группа получит его после своего хода.
   */
  nudge: (group: SplitPlanGroupRecord, prompt: string) => 'sent' | 'queued' | 'refused';
  schedule?: (run: () => void, ms: number) => unknown;
  /** Стадия разговора группы сейчас (`stageOf` её связи); не знать — `undefined`. */
  stage?: (group: SplitPlanGroupRecord) => string | undefined;
  /**
   * Новый разговор группы стадией ДОСТАВКИ (пуш и MCP записи разрешены):
   * `deliver` — вместо напоминания сессии, которая MR открыть не может (ревью,
   * план); `escalate` — разбор пробелов с историей на усиленной модели, когда
   * напоминания встали или кончились. Нет — только напоминания, как раньше.
   * `busy` — разговор группы сейчас идёт: конвейер сверит снова, а не сдастся.
   */
  freshStage?: (
    record: SplitPlanRecord,
    group: SplitPlanGroupRecord,
    prompt: string,
    mode: FreshDeliveryMode,
  ) => FreshDelivery;
}

/** Ответ нового разговора доставки (`SplitDeliveryDeps.freshStage`). */
export type FreshDelivery = 'sent' | 'queued' | 'refused' | 'busy';

/** Зачем панель заводит новый разговор доставки (`SplitDeliveryDeps.freshStage`). */
export type FreshDeliveryMode = 'deliver' | 'escalate';

/**
 * Стадии, которым MR не открыть: MCP хранилища кода у них только на чтение
 * (`READ_ONLY_STAGES` в `group-profile.ts`), а пуш закрыт звеном доставки
 * впереди. Живая группа 23.10: четыре напоминания «откройте MR» ушли в сессию
 * ревью, у которой нет `create_merge_request`.
 */
export const DELIVERY_READ_ONLY_STAGES: ReadonlySet<string> = new Set(['plan', 'review']);

/** Сколько кругов доставки помнит запись группы для разбора (`deliveryHistory`). */
export const DELIVERY_HISTORY_MAX = 8;

function rememberDeliveryRound(
  group: SplitPlanGroupRecord,
  verdict: DeliveryVerdict,
  now: Date,
): void {
  const round = {
    at: now.toISOString(),
    ...(verdict.head ? { head: verdict.head } : {}),
    missing: [...verdict.missing],
  };
  group.deliveryHistory = [...(group.deliveryHistory ?? []), round].slice(-DELIVERY_HISTORY_MAX);
}

/**
 * Потолок напоминаний о доставке (решение владельца 23.10: группа идёт до
 * готового MR сама). Раньше группа сдавалась после двух напоминаний, даже
 * когда каждое что-то двигало: rebase, прогон, новая строка отчёта. Теперь
 * сдаётся раньше потолка только напоминание, которое ничего не изменило
 * (`deliveryProgressKey`); потолок держит от бесконечного круга.
 */
export const MAX_DELIVERY_NUDGES = 6;

/**
 * Состояние доставки на напоминании: голова ветки и набор пробелов. Тот же
 * ключ на следующей проверке — напоминание ничего не изменило, и следующее
 * не изменит тоже.
 */
export function deliveryProgressKey(head: string | undefined, missing: readonly string[]): string {
  return [head ?? '', ...[...missing].sort()].join('\n');
}
/** Пауза перед повторной сверкой: ссылка MR у форджа появляется не сразу после push. */
export const DELIVERY_SETTLE_MS = 20_000;
/** Паузы между проверками, когда удалённый не отвечает; дальше — `failed` с причиной. */
export const DELIVERY_RECHECK_MS: readonly number[] = [60_000, 300_000, 900_000];
/** Удалённый лежит дольше коротких попыток: проверка раз в столько… */
export const DELIVERY_BLOCKED_PROBE_MS = 15 * 60_000;
/** …столько раз (4 часа), дальше — `failed` с причиной. */
export const DELIVERY_BLOCKED_PROBES = 16;
/**
 * Остановка, которую агенты могут снять сами (решение владельца 23.10: пробелы
 * доставки доводят агенты, не человек): напоминания и разбор встали, удалённый
 * не ответил, копия не прочлась. Раньше такая группа сразу падала, и `failed`
 * не трогал уже никто — ни сторож, ни конвейер (трасса автономии 24.10, §2).
 * Теперь через столько панель повторяет сама — разбором с журналом кругов или
 * новой сверкой фактов…
 */
export const DELIVERY_RETRY_MS = 30 * 60_000;
/** …не больше стольких раз; дальше — сдача с пунктом «панель повторила доставку сама». */
export const DELIVERY_RETRY_MAX = 2;
/**
 * Разговор группы занят в миг нового разговора доставки (`busy`): сверка снова
 * через столько, а не сдача с разбором, который так и не ушёл (§2.2)…
 */
export const DELIVERY_BUSY_RECHECK_MS = 2 * 60_000;
/** …столько раз подряд (час); дальше — обычная сдача с причиной. */
export const DELIVERY_BUSY_RECHECKS = 30;

/**
 * Хранилище объектов копии повреждено (INST-D): ни повтор, ни разбор этого не
 * починят — сначала `git fsck` руками. Раньше такая группа падала «копия не
 * читается» без шага, и повтор крутился бы впустую.
 */
const CORRUPT_STORE =
  /unresolved deltas|\bbad tree\b|fatal: bad object|\bloose object [0-9a-f]+ .*is corrupt|object file .* is empty|\bpackfile .* (?:is corrupt|cannot be accessed)|fatal: (?:index-pack|unpack-objects) failed/i;

/** Поломка хранилища объектов в тексте git (`CORRUPT_STORE`); эхо команды не считается. */
export function corruptObjectStore(reason: string): boolean {
  const text = reason
    .split('\n')
    .filter((line) => !line.trim().startsWith('Command failed:'))
    .join('\n');
  return CORRUPT_STORE.test(text);
}

/** Ответ удалённого будит повторы и пробы соседей не чаще, чем раз в столько на группу. */
const REMOTE_BACK_MS = 10 * 60_000;

/** Коды сдачи на сверке (записи до `deliveryRetry`): такую группу читает проба. */
const VERIFY_FAIL_CODES: ReadonlySet<string> = new Set([
  'split-delivery-unverifiable',
  'split-delivery-local-failed',
]);

/**
 * Сданная на сверке, а не на пробелах: копия не прочлась или удалённый молчал.
 * Её факты стоит прочесть ещё раз — вдруг доставка уже лежит.
 */
function probeable(group: SplitPlanGroupRecord): boolean {
  if (group.status !== 'failed') return false;
  if (group.deliveryRetry?.kind === 'verify') return true;
  const code = group.error ? matchText(group.error)?.messageCode : undefined;
  return code !== undefined && VERIFY_FAIL_CODES.has(code);
}

/** Состояние круга доставки группы — снимается, когда доставка найдена. */
const DELIVERY_STATE_FIELDS = [
  'deliveryMissing',
  'deliveryNudges',
  'deliveryNudgeKey',
  'deliveryNudgeStage',
  'deliveryHistory',
  'deliveryEscalatedAt',
  'deliveryEscalatedAfter',
  'deliveryRetry',
  'deliveryChecks',
  'blockedSince',
  'deliveryNotes',
] as const satisfies readonly (keyof SplitPlanGroupRecord)[];

export { trackerKeys } from '../tracker-keys.ts';

/** Сколько снятых групп разговор помнит: запись не должна расти без края. */
const RETIRED_GROUPS_MAX = 50;

/**
 * Группы прошлого плана, которые переживают новое разделение того же разговора
 * (F5.2): со своей неубранной копией или принятые человеком. Остальным помнить
 * нечего — их чаты остаются в списке снятыми звеньями и без записи плана.
 */
export function retiredGroupsOf(previous: SplitPlanRecord | undefined): SplitPlanGroupRecord[] {
  if (!previous) return [];
  return [...(previous.retiredGroups ?? []), ...previous.groups]
    .filter((group) => group.chatId && ((group.path && !group.cleaned) || group.acceptedAt))
    .slice(-RETIRED_GROUPS_MAX);
}

/** Каталог, от которого заводятся копии группы: верх репозитория, если он свой (m6). */
export function copyRootOf(record: Pick<SplitPlanRecord, 'projectPath' | 'copyRoot'>): string {
  return record.copyRoot ?? record.projectPath;
}

/**
 * Звено доставки группы ещё впереди: группа доводит до MR и не ждёт доставки
 * по фактам git (тогда цепочка кончилась, и доставляет её же чат). Общее для
 * конвейера (L3) и сторожа групп (R6).
 */
export function groupDeliverAhead(
  group: Pick<SplitPlanGroupRecord, 'deliver' | 'status' | 'waitingFor'> | undefined,
): boolean {
  if (group?.deliver !== true) return false;
  return !(group.status === 'awaiting' && group.waitingFor === 'delivery');
}

/**
 * Ветки, которые группе `index` своими не считать: ветки остальных групп плана
 * и основания всех копий, плюс ветки групп прежнего плана. Предшественник с
 * тем же ключом задачи (`fix/PROJ-1` у `fix/PROJ-1-tests`) иначе отдал бы
 * группе свою ветку и свой MR (ревью 29.09).
 */
export function claimedBranches(record: SplitPlanRecord, index: number): string[] {
  const claimed = new Set<string>();
  record.groups.forEach((group, at) => {
    if (at !== index) claimed.add(group.branch);
    if (group.base) claimed.add(group.base);
  });
  // Группы прежнего плана того же разговора (F5.2) держат свои ветки и MR.
  for (const group of record.retiredGroups ?? []) claimed.add(group.branch);
  return [...claimed];
}

/**
 * Сигналы сторожа для вида группы (F-64): блок с диска читается без схемы, и
 * `watch: {}` от ручной правки `state.json` ронял весь `/tree`. Битое — мимо.
 */
function watchSignalsView(watch: unknown): { watchSignals?: GroupSignal[] } {
  const signals = groupSignalsOf(watch);
  return signals.length > 0 ? { watchSignals: signals } : {};
}

/** Разбор разделения заведён и ещё не кончился — группы ждут его блока. */
function triagePending(record: SplitPlanRecord): boolean {
  return Boolean(record.triageChatId && !record.triage);
}

/**
 * Провайдер записи: у чужого CLI ключ родителя именованный (`codex:…`), у Claude
 * — нет. Лимит подписки у каждого провайдера свой (m11).
 */
function providerOf(record: SplitPlanRecord): string {
  return parseForeignChatKey(record.parentChatId)?.providerId ?? 'claude';
}

/** Итог хода без ссылки на MR из текста — её место займёт проверенная (T7). */
function withoutMr(outcome: ChainOutcome): ChainOutcome {
  const rest = { ...outcome };
  delete rest.mr;
  return rest;
}

/**
 * Пробелы, которые закрываются отчётом или прогоном, без единой правки кода:
 * строка сита или пункта владельца, запись прогона блока «Тесты». Только такие
 * пробелы — напоминание не велит коммитить, отправлять ветку и трогать MR
 * (L7.3 плана экономии групп, 19.10 01:46): по строке «commit, push, update the
 * MR» доставленная группа делала fetch, rebase, три гейта заново (~12 мин) и
 * переотправку ветки MR, который уже стоял на ревью, — ради блока отчёта.
 * Белый список, а не чёрный: незнакомая строка (чужой текст, новый код) ведёт
 * к прежнему напоминанию о доставке целиком.
 */
const REPORT_ONLY_GAPS: ReadonlySet<string> = new Set([
  'sieve-gap-unreported',
  'sieve-gap-no-evidence',
  'sieve-gap-stale',
  'sieve-gap-checks',
  'sieve-gap-no-run',
  'sieve-gap-run-missing',
  'sieve-gap-run-stale',
  'delivery-gap-owner-unreported',
  'delivery-gap-owner-no-evidence',
  'tests-gap-no-run',
  'tests-gap-word-only',
  'tests-gap-stale',
  'tests-gap-unrun',
]);

/** Все пробелы — отчётные (см. `REPORT_ONLY_GAPS`). */
export function reportOnlyGaps(missing: readonly string[]): boolean {
  return (
    missing.length > 0 &&
    missing.every((line) => {
      const code = matchText(line)?.messageCode;
      return code !== undefined && REPORT_ONLY_GAPS.has(code);
    })
  );
}

/** Пробелы, которые снимает только перенос ветки на свежую основную. */
const INTEGRATION_GAPS: ReadonlySet<string> = new Set(['sieve-gap-conflicts']);
/**
 * «Чужие −» rebase не снимает (F-49): ветка сама удаляет строки, пришедшие в
 * основную, — их возвращают обычным коммитом или называют в отчёте. Перезапись
 * ветки с MR на ревью без конфликта брокер к тому же отказывает.
 */
const FOREIGN_REMOVALS_GAPS: ReadonlySet<string> = new Set(['sieve-gap-foreign-removals']);
const FOREIGN_REMOVALS_LINE =
  'Foreign removals: the branch deletes lines that landed on the target branch after the group ' +
  'started. Restore them with a normal commit and a normal push, or — when the deletion is ' +
  'intended — name every such file by its full path in the foreign-removals row of the sieve ' +
  'report with the reason. Do not rebase or force-push for this: it does not clear the gap.';
/**
 * Пробелы блока «Тесты»: панель считает их раз за круг, и список устаревает, как только
 * дифф вырос (rebase: два кейса в напоминании, 27 на деле, 24.10.2026) — группа сверяет
 * его сама командой `gaps` до ответа, а не узнаёт следующим кругом.
 */
const TESTS_GAPS: ReadonlySet<string> = new Set([
  'tests-gap-no-run',
  'tests-gap-word-only',
  'tests-gap-stale',
  'tests-gap-unrun',
  'tests-gap-failed',
]);
const TESTS_SELF_CHECK_LINE =
  'Tests block: before you answer, re-check it yourself — the tests-cli named above with `gaps` ' +
  'in place of `run …` (`gaps --project .`) prints exactly the Tests-block lines this check will ' +
  'print, from the same code, for the branch as it is now. Close every line it prints in this ' +
  'turn; it exits 0 when nothing is left.';
/** Пробелы «ветка не на удалённом / MR нет» — их снимает push и открытие MR. */
const PUSH_GAPS: ReadonlySet<string> = new Set(['delivery-gap-not-pushed', 'delivery-gap-no-mr']);
/**
 * Ветки ревьюера без ответа (24.10): тот же текст, что у наблюдателя MR после
 * «готово», — ответ в ветке и сито из каждого блокера.
 */
const REVIEW_THREAD_GAPS: ReadonlySet<string> = new Set(['delivery-gap-review-threads']);
const REVIEW_THREAD_LINES: readonly string[] = [...REVIEW_REPLY_LINES, LEARN_SIEVES_LINE];

/**
 * Конфликт со свежей основной снимает только rebase (живая группа 23.10 встала
 * на нём после двух напоминаний): сказать прямо, что делать и что всё это
 * разрешено, — кроме слияния в целевую ветку.
 */
const INTEGRATION_LINE = (branch: string): string =>
  'Integration: the branch must sit on the fresh target branch. Do it now: `git fetch ' +
  'origin`, `git rebase origin/<target>` (<target> = the MR target branch; origin/HEAD ' +
  'when unsure), resolve every conflict keeping the intent of both sides, re-run the ' +
  'checks of the files you touched (and re-record the Tests-block run the lines above ' +
  `ask for), then \`git push --force-with-lease origin ${branch}\`. Every git operation ` +
  'is allowed for this group except merging into the target branch.';

/** Что можно только человеку (решение владельца 23.10) — код пункта карточки остановки. */
export { humanAsksOf, type HumanAskKind } from '../split-continue.ts';
const HUMAN_CODES = {
  merge: 'delivery-human-merge',
  destructive: 'delivery-human-destructive',
  credentials: 'delivery-human-credentials',
} as const satisfies Record<HumanAskKind, string>;

/**
 * Отказ удалённого в доступе (а не сеть): токен, ключ, логин. Код 401/403 —
 * только в ответе сервера («HTTP 403», «returned error: 403»): голое число
 * ловило имя ветки `feat/PROJ-401` в эхе команды (F-40).
 */
const REMOTE_AUTH_FAILURE =
  /authentication failed|permission denied \(publickey|could not read (?:username|password)|terminal prompts disabled|HTTP Basic: Access denied|access denied|invalid (?:username or password|credentials)|(?:\bHTTP(?:\/[\d.]+)?|\berror:|\bstatus(?: code)?:?)\s*(?:401|403)\b/i;

/** Эхо упавшей команды (`Command failed: git …`) — не текст ошибки: в нём имена веток и адреса. */
function remoteAuthFailure(reason: string): boolean {
  const text = reason
    .split('\n')
    .filter((line) => !/^Command failed:/.test(line.trim()))
    .join('\n');
  return REMOTE_AUTH_FAILURE.test(text);
}

function hasGap(missing: readonly string[], codes: ReadonlySet<string>): boolean {
  return missing.some((line) => {
    const code = matchText(line)?.messageCode;
    return code !== undefined && codes.has(code);
  });
}

/** Пробел сита, который снимает строка отчёта (конфликт снимает только rebase). */
function hasSieveRowGap(missing: readonly string[]): boolean {
  return missing.some((line) => {
    const code = matchText(line)?.messageCode;
    return code?.startsWith('sieve-gap-') === true && !INTEGRATION_GAPS.has(code);
  });
}

/** «Сдай строку заново» без формата сдачи группа 24.10 сдала прозой — круг впустую. */
const SIEVE_REPORT_HINT = `${SIEVE_REPORT_LINE} — one row for every sieve line above.`;

/**
 * Как сдать то, что группу держать не должно (решение владельца 23.10): та же
 * пара меток, что в задании сит (`NOTE_MARKS_LINE`), — промпт и панель
 * согласны, и группа не крутится на «стенда нет».
 */
const NOTE_MARKS_HINT =
  'A live check you cannot run here (no stand with this branch, no browser, no network) is not ' +
  'a blocker: report its row as fail with evidence starting "not checked: <reason>". A red ' +
  'check or case not caused by the branch (red on the target branch too, platform-only, a ' +
  'timeout in code the diff does not touch) — evidence starting "not caused by the branch: ' +
  '<why>". A Tests-block case that cannot run here (no stand, no browser) is recorded as ' +
  'blocked, not left unrun: an automated one through its run command (the run records it ' +
  'blocked), a manual one with `tests-cli record <group>:<case>=blocked --note "<why>"`. The ' +
  'panel records all of these as notes; name each in the MR description.';

/** Напоминание группе: чего не хватает, и что делать, если доставка невозможна. */
export function deliveryNudgePrompt(
  branch: string,
  missing: readonly string[],
  notes: readonly string[] = [],
): string {
  const lines = [
    "The panel checked the group's delivery against git — it is not finished. Missing:",
    // Строки пробелов — тексты сервера (русские, с кодом): модели — их английская сторона.
    ...missing.map((line) => `- ${localizeText(line, 'en')}`),
    '',
  ];
  if (notes.length > 0) {
    lines.push(
      'Notes — they do not hold the group, but the MR description must name each:',
      ...notes.map((line) => `- ${localizeText(line, 'en')}`),
      '',
    );
  }
  if (hasGap(missing, TESTS_GAPS)) lines.push(TESTS_SELF_CHECK_LINE, '');
  if (hasSieveRowGap(missing)) lines.push(SIEVE_REPORT_HINT, '');
  if (reportOnlyGaps(missing)) {
    return [
      ...lines,
      `Git is in order: the branch ${branch} and its MR are delivered. Only the report is ` +
        'missing — run what a line above names (the exact command it gives) and answer with ' +
        'the missing rows. Do not commit, push, rebase or touch the MR for this: nothing in ' +
        'the code changes.',
      NOTE_MARKS_HINT,
    ].join('\n');
  }
  if (hasGap(missing, INTEGRATION_GAPS)) lines.push(INTEGRATION_LINE(branch), '');
  if (hasGap(missing, FOREIGN_REMOVALS_GAPS)) lines.push(FOREIGN_REMOVALS_LINE, '');
  if (hasGap(missing, REVIEW_THREAD_GAPS)) lines.push(...REVIEW_THREAD_LINES, '');
  if (hasGap(missing, PUSH_GAPS)) {
    lines.push(
      `Push the branch ${branch} and open the MR yourself (or update the existing one) — ` +
        'creating the MR is allowed for this group and needs nobody to confirm it.',
      '',
    );
  }
  return [
    ...lines,
    INVESTIGATE_LINE,
    `Finish it with the delivery skill: commit the work, push the branch ${branch}, open an MR ` +
      '(or update the existing one) and give its link as the last line.',
    HUMAN_ONLY_LINE,
    NOTE_MARKS_HINT,
  ].join('\n');
}

/**
 * Каждый пробел — к причине, а не к пересказу (решение владельца 23.10): группа
 * сама читает журнал, гоняет упавшую проверку и смотрит MR, а потом чинит или
 * снимает заметкой. Панель перепроверит после хода.
 */
const INVESTIGATE_LINE =
  'For every line above, find the cause with your own tools before you answer: read the log of ' +
  'the check it names, run the failing check or case yourself, inspect the MR (pipeline, ' +
  'description) through the forge tools, read git log/status. Then fix the cause, or — when it ' +
  'is not caused by the branch or cannot run here — record a justified waiver (marks below). ' +
  'The panel re-checks every line after your turn.';

/** Пробел круга в истории — начало строки: полный текст нынешних пробелов стоит выше. */
const HISTORY_GAP_MAX = 200;

/**
 * История кругов для разбора: у круга — только пробелы, которых не было в прошлом
 * круге, и сколько перешло из него. Полным текстом каждого круга история была 20,6 тыс.
 * знаков из 36 тыс. задания (!1072, 24.10): восемь кругов повторяли одни и те же списки.
 */
function historyLines(
  history: readonly { at: string; head?: string; missing: readonly string[] }[],
): string[] {
  let previous = new Set<string>();
  return history.map((round) => {
    const gaps = round.missing.map((line) => localizeText(line, 'en'));
    const fresh = gaps.filter((line) => !previous.has(line));
    const carried = gaps.length - fresh.length;
    previous = new Set(gaps);
    const head = `- ${round.at}, head ${round.head?.slice(0, 12) ?? '—'}: `;
    if (fresh.length === 0) return `${head}same gaps as the round before`;
    const clipped = fresh.map((line) =>
      line.length > HISTORY_GAP_MAX ? `${line.slice(0, HISTORY_GAP_MAX)}…` : line,
    );
    return head + clipped.join('; ') + (carried > 0 ? `; +${carried} from the round before` : '');
  });
}

/**
 * Разбор доставки новым разговором на усиленной модели: напоминания встали
 * (та же голова, те же пробелы) или кончились. Несёт всю историю кругов —
 * что уже пробовали и что не сдвинулось, — чтобы разбор не повторил их.
 */
export function deliveryEscalationPrompt(input: {
  branch: string;
  missing: readonly string[];
  notes?: readonly string[];
  history: readonly { at: string; head?: string; missing: readonly string[] }[];
  /** Почему разбор: напоминание ничего не изменило или потолок напоминаний. */
  reason: 'stalled' | 'cap';
  nudges: number;
}): string {
  const why =
    input.reason === 'stalled'
      ? `the reminder ${input.nudges} changed nothing (same branch head, same gaps)`
      : `${input.nudges} reminders did not finish it`;
  const lines = [
    `This is a NEW diagnose-and-fix run for the delivery of the branch ${input.branch}, on a ` +
      `stronger model: ${why}. Do not repeat what was tried — find why it did not work.`,
    '',
    'Gaps now:',
    ...input.missing.map((line) => `- ${localizeText(line, 'en')}`),
  ];
  if (input.notes?.length) {
    lines.push(
      '',
      'Notes (they do not hold the group; the MR description names each):',
      ...input.notes.map((line) => `- ${localizeText(line, 'en')}`),
    );
  }
  if (input.history.length > 0) {
    lines.push(
      '',
      'Earlier rounds (when, branch head, gaps the panel sent):',
      ...historyLines(input.history),
    );
  }
  lines.push(
    '',
    'Restore the state from the facts first: git status, git log of the branch, the MR and its ' +
      'pipeline, .agent/PROGRESS.md in the copy if present, the Tests-block history.',
    INVESTIGATE_LINE,
  );
  if (hasGap(input.missing, INTEGRATION_GAPS)) lines.push(INTEGRATION_LINE(input.branch));
  if (hasGap(input.missing, FOREIGN_REMOVALS_GAPS)) lines.push(FOREIGN_REMOVALS_LINE);
  if (hasGap(input.missing, REVIEW_THREAD_GAPS)) lines.push(...REVIEW_THREAD_LINES);
  if (hasSieveRowGap(input.missing)) lines.push(SIEVE_REPORT_HINT);
  lines.push(
    `Then deliver: commit, push the branch ${input.branch}, open the MR (or update the existing ` +
      'one) and give its link as the last line. Creating the MR is allowed for this group.',
    HUMAN_ONLY_LINE,
    NOTE_MARKS_HINT,
  );
  return lines.join('\n');
}

/**
 * Сколько раз подряд панель сама продолжает оборванную группу. Дальше — кнопка
 * человека: процесс, который умирает каждый ход, сам по себе не выздоровеет.
 */
export const MAX_INTERRUPT_RESUMES = 2;

/** Пробелы последней сверки доставки, с которыми группа встала. */
type PendingDelivery = Pick<SplitPlanGroupRecord, 'deliveryMissing' | 'deliveryNotes'>;

/**
 * Продолжение посреди доставки несёт её пробелы (живой прогон 24.10): на голое
 * «продолжай» группа с паузы ответила «доделывать нечего», а ход без движения
 * сверка читает «встали» — доставка ушла бы в разбор, хотя пробелов группа не
 * видела. С пробелами продолжение — то же напоминание.
 */
function pendingDeliveryLines(branch: string, pending: PendingDelivery | undefined): string[] {
  if (!pending?.deliveryMissing?.length) return [];
  return [deliveryNudgePrompt(branch, pending.deliveryMissing, pending.deliveryNotes ?? [])];
}

const CLOSE_PENDING_LINE = 'Then close what the last delivery check before this stop found:';

/** Продолжение оборванной группы: сперва восстановить состояние по фактам, потом работать. */
export function interruptResumePrompt(branch: string, pending?: PendingDelivery): string {
  const gaps = pendingDeliveryLines(branch, pending);
  return [
    "This group's process broke off in the middle of a turn (a panel restart or the CLI died): " +
      'background commands died, whatever was not written to files is lost.',
    'First restore the state from the facts: git status, git log, what is already done — from ' +
      'your transcript; run the interrupted checks again.',
    gaps.length > 0
      ? CLOSE_PENDING_LINE
      : `Then continue from where you stopped on the branch ${branch}. If the work was already ` +
        'finished, repeat the summary of the last turn (what was done, the MR link) and stop.',
    ...gaps,
  ].join('\n');
}

/** Продолжение группы после её просьбы о сервере вне профиля (1.2). */
export function mcpConnectedPrompt(servers: readonly string[], branch: string): string {
  return [
    `The panel connected the MCP server(s) you asked for: ${servers.join(', ')}. ` +
      'A name that is not in the MCP settings stays unavailable — then go on without it.',
    `Continue from where you stopped on the branch ${branch}.`,
  ].join('\n');
}

/**
 * Подготовка и заметки разбора уходят в задание каждой группы, тетрадь, state.json
 * и хаб. «Без самих секретов» в задании разбора — только просьба: пароль, который
 * разбор всё же вписал, маскируется здесь, до первой записи (ревью B1-F16).
 */
function maskPlanSecrets(plan: SplitPlan): SplitPlan {
  return {
    ...plan,
    groups: plan.groups.map((group) => ({
      ...group,
      ...(group.notes ? { notes: maskSecretsInText(group.notes) } : {}),
      ...(group.map ? { map: maskSecretsInText(group.map) } : {}),
    })),
    ...(plan.setup ? { setup: maskSecretsInText(plan.setup) } : {}),
  };
}

/** Предложения тикетов и шагов человеку копятся через ходы, без повторов (95b). */
function collectProposals(group: SplitPlanGroupRecord, outcome: ChainOutcome, now: Date): void {
  if (outcome.tickets?.length) {
    group.tickets = mergeSplitTickets(group.tickets, outcome.tickets, now.toISOString());
  }
  if (outcome.humanSteps?.length) {
    group.humanSteps = mergeSplitHumanSteps(
      group.humanSteps,
      outcome.humanSteps,
      now.toISOString(),
    );
  }
}

/**
 * Пауза между продолжениями групп после сброса лимита (журнал 89): разом они
 * снова упёрлись бы в только что открывшийся лимит.
 */
export const LIMIT_RESUME_STAGGER_MS = 60_000;

/** Продолжение группы, ждавшей сброса лимита подписки. */
export function limitResumePrompt(branch: string, pending?: PendingDelivery): string {
  const gaps = pendingDeliveryLines(branch, pending);
  return [
    "The group's previous turn hit the subscription limit; the limit has reset and the panel " +
      'continues the work.',
    'First check the state against the facts (git status, git log, your transcript) — run the ' +
      'interrupted checks again.',
    gaps.length > 0
      ? CLOSE_PENDING_LINE
      : `Then continue from where you stopped on the branch ${branch}.`,
    ...gaps,
  ].join('\n');
}

/** Сколько фоновых команд паузы назвать агенту: дальше — длина без пользы. */
const MAX_PAUSED_TASKS = 8;

/**
 * Продолжение группы после паузы человека. Убитые паузой фоновые команды —
 * поимённо: сервер стенда посреди приёмки агент иначе искал по оборванному
 * вызову и поднимал заново наугад (L7.6, 19.10.2026).
 */
export function pauseResumePrompt(
  branch: string,
  killed: readonly string[] = [],
  pending?: PendingDelivery,
): string {
  const gaps = pendingDeliveryLines(branch, pending);
  return [
    'The human paused the group and is now resuming it. The turn that was running before the ' +
      'pause was stopped: whatever was not written to files may be lost.',
    ...(killed.length > 0
      ? [
          'The pause also killed these background commands; restart the ones the work still ' +
            `needs before relying on them: ${killed.join('; ')}.`,
        ]
      : []),
    'First check the state against the facts (git status, git log, your transcript), then ' +
      (gaps.length > 0
        ? 'close what the last delivery check before the pause found:'
        : `continue from where you stopped on the branch ${branch}.`),
    ...gaps,
  ].join('\n');
}

/** Группы, которые можно поставить на паузу: работают или ждут. */
const PAUSABLE: readonly SplitPlanGroupRecord['status'][] = ['started', 'background', 'awaiting'];
/**
 * Кнопкой хаба — ещё и группу из очереди (живой прогон 29.09): человек держит её,
 * пока доработают остальные. Остановка в чате её не касается — чата у неё нет.
 */
const PAUSABLE_BY_HUB: readonly SplitPlanGroupRecord['status'][] = [...PAUSABLE, 'pending'];

/** Любой статус: профилю запуска группа нужна и на продолжении после «готово». */
const ALL_GROUP_STATUSES: readonly SplitPlanGroupRecord['status'][] = [
  'pending',
  'waiting',
  'held',
  'started',
  'awaiting',
  'background',
  'paused',
  'done',
  'failed',
];

/**
 * Группа хоть раз стартовала — на паузе она держит своё место (живой прогон
 * 29.09). Поставленная на паузу из очереди стартовой отметки не имеет.
 */
function seated(group: SplitPlanGroupRecord): boolean {
  return Boolean(group.startedAt || group.chatId || group.path);
}

/** Предел таймера Node (~24.8 суток): дальше `setTimeout` срабатывает сразу. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Часы сброса лимита по времени панели — для текста человеку. */
function clockTime(iso: string): string {
  const at = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** Что конец хода значит для группы (Д3). */
export interface ChainOutcome {
  status: 'done' | 'failed' | 'awaiting' | 'background';
  waitingFor?: SplitPlanRecord['groups'][number]['waitingFor'];
  /** Хвост ответа — строке группы в хабе (Д16). */
  tail?: string;
  /**
   * Строки `HUMAN:` из ПОЛНОГО текста хода (`humanAsksOf`), не из хвоста: хвост
   * обрезан до 280 знаков спереди и терял метку длинной строки.
   */
  humanAsks?: { kind: HumanAskKind; what: string }[];
  /** Ссылка на MR, названная в ответе (доставка группы). */
  mr?: string;
  /** Что сделано по фактам копии (Д5). */
  result?: SplitPlanRecord['groups'][number]['result'];
  error?: string;
  /** Сколько раз надзор уже повторил упавший ход группы (Д10). */
  retries?: number;
  /** Ход упёрся в лимит подписки: до какого момента ждать сброса (ISO, журнал 89). */
  limitUntil?: string;
  /**
   * Лимит на исходе (`allowed_warning`, аудит 25.09, L63): ход прошёл, но
   * новых групп до сброса (ISO) заводить нельзя.
   */
  limitWarningUntil?: string;
  /** Ход ревью кончил цепочку: замечаний в вердикте; нет — вердикта не было. */
  reviewFindings?: number;
  /** Блоки тикетов из текста хода — дефекты вне задач группы (95b). */
  tickets?: SplitTicketProposal[];
  /** Шаги, которые группа сделать не может, а человек может (находка 112). */
  humanSteps?: SplitHumanStepProposal[];
  /** Строки отчёта о ситах из текста хода. */
  sieveRows?: SieveReportRow[];
  /** Сита, выученные группой по тредам её MR, — ещё не проверенные. */
  learnedSieves?: LearnedSieveRow[];
  /** MCP-серверы вне профиля, которые группа попросила блоком `mcp` (1.2). */
  mcpRequests?: string[];
}

export interface SplitBeginInput {
  parentChatId: string;
  projectPath: string;
  /** Верх репозитория для копий, если проект — его подкаталог (m6). */
  copyRoot?: string;
  proposal: SplitPlanRecord['proposal'];
  request: SplitPlanRecord['request'];
}

/** Какие группы порции стартовали — для ответа маршруту и записи. */
function absorb(record: SplitPlanRecord, result: TaskSplitResult, at: string): void {
  for (const chat of result.chats) {
    const group = record.groups.find((item) => item.index === chat.index);
    if (!group) continue;
    // Прогон не пускали (пауза или отмена во время подготовки): копия есть,
    // чата нет, статус уже решил человек.
    if (chat.held) {
      group.path = chat.path;
      group.branch = chat.branch;
      continue;
    }
    group.chatId = chat.chatId;
    group.path = chat.path;
    group.branch = chat.branch;
    group.startedAt = at;
    // Цепочка группы могла кончиться РАНЬШЕ, чем вернулся её запуск: у чужого
    // CLI ответ приходит в собственном темпе, и короткая работа успевает
    // закрыться, пока порция ещё заводит соседние копии. Написать поверх этого
    // «стартует» значило бы потерять факт: ждавшие её группы стояли бы вечно.
    // Решение «До MR» пишется и «нет»: без него шапка чата группы брала бы
    // настройку проекта, а та с планом расходится (живой прогон 25.09, O2).
    group.deliver = chat.deliver === true;
    if (chat.reviewStand) group.stand = chat.reviewStand;
    if (group.status === 'done' || group.status === 'failed') continue;
    group.status = chat.started ? 'started' : 'failed';
    if (!chat.started) group.error = serverText('split-group-run-not-started');
  }
  for (const failure of result.failures) {
    const group = record.groups.find((item) => item.index === failure.index);
    // Как и у брошенного запуска: пауза, «Убрать» и отмена плана, решённые
    // человеком за время подготовки, ошибкой копии не перетираются (N9).
    if (!group || record.cancelledAt || group.status !== 'started') continue;
    group.status = 'failed';
    group.error = failure.message;
    group.doneAt = at;
  }
}

/**
 * Код вопроса, стоящего перед группой, — чтобы панель показала его на языке
 * интерфейса, а не по-русски.
 *
 * Читается ИЗ ГОТОВОЙ СТРОКИ, а не хранится рядом с ней, по двум причинам.
 * Вопрос обычно пишет агент — свободный текст, шаблоном он не читается и кода
 * не получает, и поле рядом с ним стояло бы пустым у всех записей, кроме одной.
 * А та одна, панельная, лежит на диске с прежних запусков: запись пережила
 * перезапуск, который её и породил, и поле, заведённое сегодня, ей взяться
 * неоткуда. Разбор же узнаёт её и там.
 *
 * Русская строка едет рядом и остаётся запасной: чужому CLI родительская лента
 * умеет только строку, да и клиент постарше кода не знает.
 */
function holdCode(text: string): Pick<SplitPlanView['groups'][number], 'holdCode' | 'holdParams'> {
  const matched = matchText(text);
  if (!matched) return {};
  return {
    holdCode: matched.messageCode,
    ...(matched.params ? { holdParams: matched.params } : {}),
  };
}

export class SplitConveyor {
  private readonly now: () => Date;
  /**
   * Группы, чей запуск идёт прямо сейчас (`${родитель}:${номер}`): копия ещё
   * заводится. «Продолжить» такую группу не заводит второй запуск — только
   * возвращает ей «стартует», и идущий запуск пускает прогон сам. Счётчик, а
   * не множество: перезапуск посреди подготовки заводит второй запуск той же
   * группы, и конец первого не должен снять отметку, нужную второму.
   */
  private readonly inFlight = new Map<string, number>();
  private readonly deps: SplitConveyorDeps;
  /** Когда поставлен таймер сброса лимита (мс); таймер один на все записи. */
  private limitWakeAt: number | undefined;
  /**
   * Номер последнего поставленного таймера. Отменить таймер нельзя, а более
   * ранний срок другого провайдера (m11) ставит новый поверх: старый, сработав,
   * продолжил бы те же группы второй раз — он узнаёт себя устаревшим по номеру.
   */
  private limitWakeToken = 0;
  /**
   * Сверки подряд, на которых разговор группы был занят (`busy`), по
   * `${родитель}#${номер}`. В памяти: перезапуск и так сверяет заново
   * (`recoverDeliveryChecks`), а счёт лишь не даёт ждать вечно.
   */
  private readonly deliveryBusy = new Map<string, number>();
  /** Когда ответ удалённого последний раз будил группу (`remoteBack`), мс. */
  private readonly remoteBackAt = new Map<string, number>();

  constructor(deps: SplitConveyorDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
    this.ticketMarks = new SplitTicketMarks(deps.store, () => this.now());
  }

  /**
   * Человек согласился на разделение при включённом подборе: записать
   * разделение и запустить разбор. Копий ещё нет — они заводятся по его итогу.
   * Разбор не стартовал (реестр отказал) — группы заводятся сразу, без него.
   */
  async begin(
    input: SplitBeginInput,
  ): Promise<{ record: SplitPlanRecord; result: TaskSplitResult }> {
    const at = this.now().toISOString();
    const record: SplitPlanRecord = {
      parentChatId: input.parentChatId,
      projectPath: input.projectPath,
      ...(input.copyRoot && normalizePath(input.copyRoot) !== normalizePath(input.projectPath)
        ? { copyRoot: input.copyRoot }
        : {}),
      createdAt: at,
      order: input.proposal.groups.map((_, index) => index),
      request: input.request,
      proposal: input.proposal,
      groups: input.proposal.groups.map((group, index) => ({
        index,
        title: group.title,
        branch: safeBranchName(group.branch),
        after: [],
        status: 'pending',
      })),
    };
    const retiredGroups = retiredGroupsOf(this.deps.store.get(input.parentChatId));
    if (retiredGroups.length > 0) record.retiredGroups = retiredGroups;

    // Разбор разводит группы по файлам ДО работы. Ревью по ссылкам (Т7) разводить
    // не надо и нечем: каждая группа читает свой чужой MR в своей копии, ничего
    // не правя, — и разбор на потолке был бы минутами ожидания ради пустого
    // ответа. Такое разделение стартует сразу.
    if (record.proposal.groups.every((group) => group.review)) {
      // Записи разбора не оставляем вовсе: «разбор не получен» здесь читалось бы
      // как сбой, а разбора тут не было и не должно быть.
      this.deps.store.set(record);
      return { record, result: await this.launchReady(record) };
    }

    const catalog = this.deps.groupCatalog?.(record);
    if (catalog && catalog.length > 0) {
      record.groupCatalog = catalog.map((entry) => ({ key: entry.key, name: entry.name }));
    }
    const prompt = triageStagePrompt({
      ...(input.proposal.shared ? { shared: input.proposal.shared } : {}),
      ...(record.groupCatalog && catalog ? { catalog } : {}),
      groups: input.proposal.groups.map((group) => ({
        title: group.title,
        branch: group.branch,
        tasks: group.tasks,
        ...(group.brief ? { brief: group.brief } : {}),
        ...(group.kind ? { kind: group.kind } : {}),
      })),
    });
    const triage = this.deps.startTriage(record, prompt, (chatId) => {
      record.triageChatId = chatId;
      this.deps.store.set(record);
    });
    record.triageChatId = triage.chatId;
    this.deps.store.set(record);

    if (triage.started || triage.deferred) {
      return {
        record,
        result: {
          chats: [],
          failures: [],
          triage: { chatId: triage.chatId, path: input.projectPath, started: triage.started },
        },
      };
    }

    // Разбор не стартовал — уровень 1 не блокирует: группы идут как есть.
    record.triage = { at, received: false, repairs: [], conflicts: [] };
    this.deps.store.set(record);
    const result = await this.launchReady(record);
    return { record, result };
  }

  /**
   * Чат разбора закончился: применить блок к записи и завести порцию групп без
   * ожиданий. Событие — в ленту разбора, синхронно (планировщик реестра
   * синхронный); сами копии заводятся следом, вне этого вызова.
   *
   * От прогона нужны только исход и текст, и потому тип сужен: у чужого CLI
   * прогона в реестре нет вовсе — есть законченный ответ его хранилища.
   */
  onTriageFinished(
    finished: Pick<RunFinished, 'ok' | 'text'> & Partial<RunFinished>,
    aliases: readonly string[],
  ): ChatEvent | undefined {
    const record = this.deps.store.findByTriage(aliases);
    // Отменённый план итогом разбора не оживает: группы закрыты человеком.
    if (!record || record.triage || record.cancelledAt) return undefined;

    const at = this.now().toISOString();
    const titles = record.proposal.groups.map((group) => group.title);
    const scan = finished.ok ? scanSplitPlanBlocks(finished.text, titles) : undefined;
    const plan = scan?.plan ? maskPlanSecrets(scan.plan) : undefined;
    const applied = plan ? applySplitPlan(record.proposal.groups, plan) : undefined;
    /** Группы панели, выбранные разбором, — строкой ««группа» → набор» на каждую. */
    const picks: string[] = [];

    if (applied) {
      record.order = applied.order;
      for (const group of applied.groups) {
        const source = record.proposal.groups[group.index];
        const state = record.groups[group.index];
        if (!source || !state) continue;
        source.tasks = group.tasks;
        if (group.owns.length > 0) source.owns = group.owns;
        else delete source.owns;
        if (group.notes) source.notes = group.notes;
        else delete source.notes;
        const picked = this.pickOf(record, group.groupKey);
        if (picked) {
          source.groupKey = picked.key;
          picks.push(`«${source.title}» → ${picked.name}`);
        }
        state.after = group.after;
        if (group.hold) state.hold = group.hold;
        // Пауза и «Убрать» человека посреди разбора блоком не отменяются (ревью PR #1).
        if (state.status === 'pending') {
          state.status = group.hold ? 'held' : group.after.length > 0 ? 'waiting' : 'pending';
        }
      }
    }
    record.triage = {
      at,
      received: Boolean(applied),
      repairs: applied?.repairs ?? [],
      conflicts: applied?.conflicts ?? [],
    };
    this.deps.store.set(record);

    // Счёт — ДО запуска порции: она синхронно переводит готовые группы в
    // «стартует», и считать после неё значило бы сообщить «сразу: 0».
    const held = record.groups.filter((group) => group.status === 'held').length;
    const waiting = record.groups.filter((group) => group.status === 'waiting').length;
    const ready = record.groups.filter((group) => group.status === 'pending').length;

    void this.launchReady(record).catch((error) => {
      this.deps.log('split conveyor: launch after triage failed', error);
    });

    const summary = [
      `стартуют сразу: ${ready}`,
      waiting ? `ждут предшественников: ${waiting}` : '',
      held ? `ждут ответа человека: ${held}` : '',
      applied && applied.conflicts.length > 0
        ? `пересечений разведено: ${applied.conflicts.length}`
        : '',
      applied && applied.repairs.length > 0
        ? `поправлено панелью: ${applied.repairs.join('; ')}`
        : '',
    ]
      .filter(Boolean)
      .join(' · ');

    // Выбор групп — в ленту родителя кодом: сводка выше шаблона не имеет, а
    // что каждой группе выбрано, человек должен прочитать на своём языке.
    if (picks.length > 0) {
      const params = { picks: picks.join('; ') };
      this.deps.notify?.(record.parentChatId, {
        kind: 'notice',
        code: 'triageApplied',
        text: serverText('split-triage-groups-picked-notice', params),
        textCode: 'split-triage-groups-picked-notice',
        textParams: params,
      });
    }
    const pickLine =
      picks.length > 0
        ? ` ${serverText('split-triage-groups-picked-notice', { picks: picks.join('; ') })}`
        : '';

    return applied
      ? {
          kind: 'notice',
          code: 'triageApplied',
          text: `Разбор применён — ${summary}.${pickLine}`,
        }
      : {
          kind: 'notice',
          code: 'triageMissing',
          text: `Разбор не получен (${finished.ok ? 'блока в ответе нет' : 'прогон не завершился'}) — группы стартуют как предложено: ${summary}.`,
        };
  }

  /**
   * Выбор разбора, сверенный с каталогом, который ему предлагали. Незнакомый
   * ключ (модель выдумала или переписала) отбрасывается с записью в журнал:
   * группа идёт без выбора, как шла бы без каталога.
   */
  private pickOf(
    record: SplitPlanRecord,
    groupKey: string | undefined,
  ): { key: string; name: string } | undefined {
    if (!groupKey) return undefined;
    const entry = record.groupCatalog?.find((item) => item.key === groupKey);
    if (!entry) this.deps.log(`split conveyor: triage picked an unknown group ${groupKey}`);
    return entry;
  }

  /**
   * Разбор, оборванный перезапуском панели: разморозить разделение.
   *
   * Итог разбора применяет РОВНО ОДИН вызов — завершение его прогона. Штатное
   * закрытие панели CLI уже отпускает (`detachAll`), но разбор, умерший вместе с
   * машиной или убитый снаружи, журнал прогонов на старте выбрасывает как запись
   * без живого pid, и завершение не приедет уже никогда:
   * запись остаётся с `triage: undefined`, все группы — `pending`, копий нет, и
   * сдвинуть это нечем (ответ на вопрос отвечает 409 — группы не `held`).
   *
   * Поэтому на старте, когда живые прогоны уже усыновлены, каждая такая запись
   * закрывается: «разбор не получен» — и группы встают на вопрос ЧЕЛОВЕКУ.
   * Автоматически здесь не заводится ничего: разбор обещал развести границы,
   * его нет, и запустить группы за человека значило бы принять за него решение,
   * которое он полчаса назад доверил умной модели. Возраст записи не при чём
   * ровно потому, что без его клика ничего не стартует.
   *
   * `alive` — жив ли чат разбора (усыновлённый прогон). Повторный запуск панели
   * ничего не повторяет: `record.triage` уже стоит.
   */
  recoverInterruptedTriage(
    alive: (chatId: string) => boolean,
  ): { parentChatId: string; event: ChatEvent }[] {
    const notices: { parentChatId: string; event: ChatEvent }[] = [];
    const at = this.now().toISOString();

    for (const record of Object.values(this.deps.store.all())) {
      if (!record.triageChatId || record.triage) continue;
      if (alive(record.triageChatId)) continue;

      let frozen = 0;
      for (const group of record.groups) {
        // Трогаем только нерешённые: всё остальное разбор и не держал.
        if (group.status !== 'pending') continue;
        group.status = 'held';
        group.hold = serverText('split-triage-interrupted-hold');
        frozen += 1;
      }
      record.triage = { at, received: false, interrupted: true, repairs: [], conflicts: [] };
      this.deps.store.set(record);

      notices.push({
        parentChatId: record.parentChatId,
        event: {
          kind: 'notice',
          code: 'triageMissing',
          text: serverText('split-triage-interrupted-notice', { groups: frozen }),
          textCode: 'split-triage-interrupted-notice',
          textParams: { groups: frozen },
        },
      });
    }

    return notices;
  }

  /**
   * Ход звена группы кончился, и следующего звена нет. Что это значит для
   * группы, решает `outcome` (Д3): явный итог (`done`), сбой (`failed`) или
   * пауза, которая группу НЕ закрывает — вопрос человеку, решение по ревью,
   * фоновая команда. Раньше любой конец хода был `done`: хаб писал «готово»,
   * ждавшие группы стартовали от недоделанной ветки, а статус больше не менялся,
   * даже когда человек продолжил ребёнка.
   *
   * Ждущих отпускают только `done` и `failed`. Закрытую группу конец хода не
   * трогает: снова открывает её только новый прогон (`onChainResumed`).
   */
  onChainEnded(link: ChatLink, outcome: ChainOutcome): void {
    const record = this.deps.store.get(link.parentChatId);
    if (!record) return;
    const group = this.groupOf(record, link, ['started', 'awaiting', 'background']);
    if (!group) return;
    traceStage(group, link, this.now(), outcome.reviewFindings);
    // Отчёт о ситах всех звеньев цепочки — в запись группы: его судит проверка
    // доставки, а следующий круг (продолжение по MR) досдаёт недостающее.
    const sieveRows = mergeSieveRows(
      mergeSieveRows(group.sieveRows, link.sieveRows ?? []),
      outcome.sieveRows ?? [],
    );
    if (sieveRows.length > 0) group.sieveRows = sieveRows;
    if (outcome.learnedSieves?.length) this.learnSieves(record, group, outcome.learnedSieves);
    // Просьба о сервере вне профиля (1.2): сервер заносится в профиль. Ход, который
    // больше ничего не ждёт, — не итог: группа ждала инструмента, и та же сессия
    // продолжает следующим ходом. Вопрос человеку, фоновая команда или названный MR
    // судятся как обычно, а сервер приедет со следующим ходом — продолжение их
    // проглотило бы (ревью B1-F13/A1-F15).
    const fresh =
      outcome.status === 'failed' ? [] : this.addMcp(record, group, outcome.mcpRequests);
    if (fresh.length > 0 && outcome.status === 'done' && !outcome.mr) {
      if (this.resumeWithMcp(record, group, fresh, outcome)) return;
    }
    // «Без правок» сказано о последнем звене, а итог — о группе: ревью-звено,
    // заведённое после её коммитов, писало «без правок» ветке с двумя коммитами.
    const ownWork =
      outcome.result?.kind === 'unchanged' && group.path && group.startedAt && this.deps.hasWork
        ? this.deps.hasWork(group.path, group.startedAt)
        : undefined;
    if (ownWork) outcome = { ...outcome, result: { kind: 'changed' } };

    // Группа с доставкой закрывается только по фактам git (живой прогон 24.09:
    // «готово» у групп без push, без MR и со ссылкой на чужой MR). До ответа
    // проверки группа ждёт, место в очереди держит, ждавших не отпускает.
    if (group.deliver && this.deps.delivery) {
      // Ссылка из текста ответа — не факт (T7): агент называет и чужие MR
      // («зависит от !789»), и группа показывала чужой. У группы с доставкой в
      // запись попадает только MR, найденный проверкой по голове её ветки;
      // названный агентом идёт проверке подсказкой.
      const unverified = withoutMr(outcome);
      if (outcome.status !== 'done') {
        this.settle(record, group, unverified);
        return;
      }
      // Своих правок у группы с самого старта нет (живое разделение, 10.10):
      // сдавать нечего, а MR без правок — не итог. Раньше такая группа вставала
      // ждать доставки, которой не будет, и получала напоминания «нет MR».
      if (ownWork === false) {
        this.settle(record, group, { ...unverified, result: { kind: 'nothing' } });
        return;
      }
      this.apply(group, { ...unverified, status: 'awaiting', waitingFor: 'delivery' });
      this.deps.store.set(record);
      this.verifyDelivery(record.parentChatId, group.index, outcome);
      return;
    }
    this.settle(record, group, outcome);
  }

  /**
   * Новые серверы из просьбы группы — в `mcpExtra`; возвращает новые. Уже
   * подключённый сервер новым не считается: иначе агент, попросивший имя,
   * которого нет в настройках, ходил бы по кругу продолжений.
   */
  private addMcp(
    record: SplitPlanRecord,
    group: SplitPlanGroupRecord,
    requests: readonly string[] | undefined,
  ): string[] {
    const known = new Set(group.mcpExtra ?? []);
    const fresh = (requests ?? []).filter((name) => !known.has(name));
    if (fresh.length === 0) return [];
    group.mcpExtra = [...known, ...fresh];
    this.deps.store.set(record);
    return fresh;
  }

  /**
   * Ход продолжения с новыми серверами. Тикеты и шаги человеку из того же хода
   * сохраняются до него — иначе пропали бы вместе с несуженным итогом. Продолжение
   * не приняли — ход судится как обычно, а сервер приедет со следующим ходом.
   */
  private resumeWithMcp(
    record: SplitPlanRecord,
    group: SplitPlanGroupRecord,
    fresh: readonly string[],
    outcome: ChainOutcome,
  ): boolean {
    if (!this.deps.resume || !group.chatId || !group.path) return false;
    collectProposals(group, outcome, this.now());
    this.deps.store.set(record);
    const prompt = this.withIdentity(record, group, mcpConnectedPrompt(fresh, group.branch));
    if (this.deps.resume(group, prompt) !== 'refused') return true;
    this.deps.log(`split conveyor: group «${group.title}» MCP resume refused`);
    return false;
  }

  /**
   * Что профиль запуска группы знает о ней (1.2): текст задач — по нему решается,
   * нужны ли макеты, — и серверы, которые она уже попросила. Не группа — пусто.
   */
  profileInput(
    link: ChatLink,
  ): { tasksText: string; extra: string[]; projectPath: string } | undefined {
    const record = this.deps.store.get(link.parentChatId);
    if (!record) return undefined;
    const group = this.groupOf(record, link, ALL_GROUP_STATUSES);
    if (!group) return undefined;
    const proposal = record.proposal.groups[group.index];
    const tasksText = [
      group.title,
      ...(proposal?.tasks ?? []),
      proposal?.brief,
      proposal?.notes,
      record.proposal.shared,
      group.holdAnswer,
    ]
      .filter((part): part is string => Boolean(part))
      .join('\n');
    return { tasksText, extra: group.mcpExtra ?? [], projectPath: record.projectPath };
  }

  /**
   * Сита, выученные группой по тредам её MR. Проверяет хранилище: тред должен
   * быть среди тех, что наблюдатель MR сам переслал группе (`relayedLinks`).
   */
  private learnSieves(
    record: SplitPlanRecord,
    group: SplitPlanGroupRecord,
    rows: readonly LearnedSieveRow[],
  ): void {
    const sieves = this.deps.sieves;
    if (!sieves) return;
    try {
      const outcome = sieves.learn({
        rows,
        relayed: group.mrWatch?.relayedLinks ?? [],
        ...(group.mrWatch?.relayedPaths ? { paths: group.mrWatch.relayedPaths } : {}),
        projectPath: record.projectPath,
        ...(group.mr ? { mr: group.mr } : {}),
      });
      this.deps.log(
        `split conveyor: group «${group.title}» sieves learned ${outcome.accepted.length}, rejected ${outcome.rejected.length}`,
      );
    } catch (error) {
      this.deps.log('split conveyor: learning sieves failed', error);
    }
  }

  /** Итог хода — в запись группы (без записи в хранилище). */
  private apply(group: SplitPlanGroupRecord, outcome: ChainOutcome): void {
    group.status = outcome.status;
    if (outcome.waitingFor) group.waitingFor = outcome.waitingFor;
    else delete group.waitingFor;
    if (outcome.tail) group.tail = outcome.tail;
    // Ссылку не стираем ходом без неё: вопрос после создания MR MR не отменяет.
    if (outcome.mr) group.mr = outcome.mr;
    if (outcome.result) group.result = outcome.result;
    if (outcome.retries) group.retries = outcome.retries;
    if (outcome.status === 'failed') {
      group.error = outcome.error ?? serverText('split-group-chain-failed');
    } else delete group.error;
    if (outcome.status === 'done' || outcome.status === 'failed') {
      group.doneAt = this.now().toISOString();
    } else delete group.doneAt;
    // «Перепроверить MR» (владелец 05.10): ход, НЕСУЩИЙ перепроверку, кончился
    // доставкой — отметка со временем; сбоем — перепроверка снята. Другой ход,
    // кончившийся, пока перепроверка ждёт места, её не засчитывает (ревью R1).
    if (group.recheckRunning && outcome.status === 'done') {
      group.recheckedAt = this.now().toISOString();
      dropRecheck(group);
    } else if (outcome.status === 'failed') dropRecheck(group);
    // Ход дошёл до конца — обрыв позади, и счёт самостоятельных продолжений
    // начинается заново.
    if (outcome.waitingFor !== 'interrupted') {
      delete group.interruptedAt;
      delete group.interruptResumes;
    }
    // Срок сброса лимита — только у хода, упёршегося в лимит (журнал 89).
    if (outcome.waitingFor === 'limit' && outcome.limitUntil) group.limitUntil = outcome.limitUntil;
    else delete group.limitUntil;
    collectProposals(group, outcome, this.now());
  }

  /** Итог хода принят: записать, освободить место, отпустить ждавших. */
  private settle(
    record: SplitPlanRecord,
    group: SplitPlanGroupRecord,
    outcome: ChainOutcome,
  ): void {
    this.apply(group, outcome);
    this.deps.store.set(record);
    if (group.limitUntil) this.noteLimit(record, group.limitUntil);
    // Лимит на исходе (аудит 25.09, L63): только заметка родителю — очередь
    // не держит (решение владельца 29.09, см. `limitHorizons`).
    else if (outcome.limitWarningUntil) this.noteLimit(record, outcome.limitWarningUntil, true);
    // Группа ждёт (человека, фон, повтор) — место она держит (M7): ответ
    // человека продолжит её в этом же месте, а не сверх потолка. Ждавших её это
    // не отпускает: они стоят до `done`/`failed`.
    if (outcome.status !== 'done' && outcome.status !== 'failed') return;

    // Сверка веток (Т6) — до запуска ждавших: работа этой группы уже легла, и
    // считать её пересечения можно прямо сейчас. Оно асинхронное и отдельное:
    // ни один отказ git не должен помешать соседям стартовать.
    this.deps.watchOverlap?.(record.parentChatId);
    this.measureTokens(record, group);
    this.closeReviewGroup(record, group);

    void this.launchNext(record).catch((error) => {
      this.deps.log('split conveyor: launch after chain end failed', error);
    });
  }

  /**
   * Закрытие группы ревью по ссылке: итог по её копии пишется в запись и на
   * карточку. Асинхронное и отдельное, как счёт токенов: сбой уборки группу не
   * держит, а ждавшие её стартуют сразу.
   */
  private closeReviewGroup(record: SplitPlanRecord, group: SplitPlanGroupRecord): void {
    const close = this.deps.closeReview;
    if (!close || !record.proposal.groups[group.index]?.review) return;
    // Правки группы ревью, которая чинила по решению человека, — не «грязь»: `git status` копии
    // нужен только ревью без правок, а база и временные копии убираются в любом случае.
    const readOnly = !group.result || group.result.kind === 'reviewed';
    const { parentChatId } = record;
    const { index } = group;
    void close(record, group, { dirt: readOnly })
      .then((closed) => {
        if (!closed) return;
        const fresh = this.deps.store.get(parentChatId);
        const same = fresh?.groups[index];
        if (!fresh || !same) return;
        same.reviewClose = closed;
        if (closed.standRemoved) delete same.stand;
        this.deps.store.set(fresh);
      })
      .catch((error: unknown) => {
        this.deps.log('split conveyor: review close failed', error);
      });
  }

  /**
   * Счёт токенов закрытой группы (E4). Асинхронный — транскрипты бывают в
   * десятки мегабайт; запись перечитывается после ответа, сбой счёта группу
   * не трогает.
   */
  private measureTokens(record: SplitPlanRecord, group: SplitPlanGroupRecord): void {
    const measure = this.deps.tokenLedger;
    if (!measure) return;
    const { parentChatId } = record;
    const { index } = group;
    void measure(record, group, providerOf(record))
      .then((ledger) => {
        if (!ledger) return;
        const fresh = this.deps.store.get(parentChatId);
        const same = fresh?.groups[index];
        if (!fresh || !same) return;
        same.tokenLedger = ledger;
        this.deps.store.set(fresh);
      })
      .catch((error: unknown) => {
        this.deps.log('split conveyor: token ledger failed', error);
      });
  }

  /**
   * Счёт группы для хаба — с медианой холодного старта по всем группам того
   * же проекта: «тяжёлый старт» значит тяжелее, чем обычно здесь.
   */
  private tokenView(
    record: SplitPlanRecord,
    ledger: SplitTokenLedger,
  ): { tokenLedger: SplitTokenLedger; tokenFlags?: SplitTokenFlag[]; tokenMedian?: number } {
    const project = record.projectPath ? normalizePath(record.projectPath) : undefined;
    const peers = Object.values(this.deps.store.all())
      .filter((other) =>
        project
          ? other.projectPath !== undefined && normalizePath(other.projectPath) === project
          : other.parentChatId === record.parentChatId,
      )
      .flatMap((other) => other.groups.flatMap((group) => group.tokenLedger ?? []));
    const median = coldStartMedian(peers);
    const flags = tokenFlags(ledger, median);
    return {
      tokenLedger: ledger,
      ...(flags.length > 0 ? { tokenFlags: flags } : {}),
      ...(median !== undefined ? { tokenMedian: median } : {}),
    };
  }

  /**
   * Счёт группы в виде с пингами тёплого кэша: они видны и у ждущей группы —
   * счёт закрытия к ним дописывается позже. Пинги — из учёта пингов; запись
   * плана — только старое поле, писавшееся до него.
   */
  private groupTokenView(
    record: SplitPlanRecord,
    group: SplitPlanGroupRecord,
  ): Partial<ReturnType<SplitConveyor['tokenView']>> {
    const keepWarm = this.deps.store.keepWarm?.(record.parentChatId, group.index) ?? group.keepWarm;
    if (!group.tokenLedger && !keepWarm) return {};
    return this.tokenView(record, {
      ...(group.tokenLedger ?? { at: keepWarm?.lastAt ?? '' }),
      ...(keepWarm ? { keepWarm } : {}),
    });
  }

  /**
   * Проверка доставки по фактам git. Асинхронная (`ls-remote` ходит в сеть),
   * и после ответа запись перечитывается: за это время человек мог продолжить
   * группу, и тогда итог проверки уже не про неё.
   */
  private verifyDelivery(
    parentChatId: string,
    index: number,
    outcome: ChainOutcome,
    settled = false,
  ): void {
    const delivery = this.deps.delivery;
    const record = this.deps.store.get(parentChatId);
    const group = this.deliveryPending(parentChatId, index);
    if (!delivery || !record || !group) return;
    void delivery
      .facts(group, outcome.mr ?? group.mr, copyRootOf(record), claimedBranches(record, index))
      .catch((error: unknown): DeliveryVerdict => {
        // Недоступный удалённый приходит ответом (`unreachable` от ls-remote), а
        // не исключением. Исключение — это сама копия: git status/rev-parse не
        // прочли её (каталог снесён, репозиторий сломан). Ждать тут нечего — 3
        // коротких и 16 долгих попыток держали бы место четыре часа ради сбоя.
        this.deps.log('split conveyor: delivery facts failed', error);
        return { missing: [], failed: error instanceof Error ? error.message : String(error) };
      })
      .then((verdict) => {
        this.onDeliveryFacts(parentChatId, index, outcome, verdict, settled);
        // Удалённый ответил — повторы и сдачи соседей по нему же не ждут своего срока.
        if (!verdict.failed && !verdict.unreachable) this.remoteBack(parentChatId, index);
      });
  }

  /** Группа всё ещё ждёт проверки доставки — иначе ответ проверки не про неё. */
  private deliveryPending(parentChatId: string, index: number): SplitPlanGroupRecord | undefined {
    const group = this.deps.store.get(parentChatId)?.groups[index];
    return group?.status === 'awaiting' && group.waitingFor === 'delivery' ? group : undefined;
  }

  private onDeliveryFacts(
    parentChatId: string,
    index: number,
    outcome: ChainOutcome,
    verdict: DeliveryVerdict,
    settled: boolean,
  ): void {
    const record = this.deps.store.get(parentChatId);
    const group = record?.groups[index];
    if (!record || !group || !this.deliveryPending(parentChatId, index)) return;
    // Группа отправила ветку под своим именем (живой прогон 29.09: правило
    // проекта — ключи через запятую): запись переходит на него, иначе хаб,
    // наблюдатель MR и повторные проверки смотрели бы на ветку, которой нет.
    if (verdict.branch && verdict.branch !== group.branch) {
      this.deps.log(
        `split conveyor: group «${group.title}» delivered on its own branch ${verdict.branch} (panel named ${group.branch})`,
      );
      group.branch = verdict.branch;
      this.deps.store.set(record);
    }
    const schedule = this.deps.delivery?.schedule ?? setTimeout;
    const again = (asSettled: boolean, ms: number): void => {
      schedule(() => this.verifyDelivery(parentChatId, index, outcome, asSettled), ms);
    };

    // Хранилище объектов копии повреждено (INST-D) — ни повтор, ни разбор это
    // не починят: сразу «нужен человек» с шагом `git fsck --full`.
    const corrupt = [verdict.failed, verdict.unreachable].find(
      (reason): reason is string => typeof reason === 'string' && corruptObjectStore(reason),
    );
    if (corrupt) {
      this.deliveryBusy.delete(`${parentChatId}#${index}`);
      const line = serverText('delivery-human-corrupt-store', {
        path: group.path ?? '—',
        what: corrupt.replace(/\s+/g, ' ').trim().slice(0, 200),
      });
      delete group.deliveryChecks;
      delete group.blockedSince;
      delete group.deliveryRetry;
      group.deliveryMissing = [line];
      this.settle(record, group, {
        ...withoutMr(outcome),
        status: 'failed',
        error: deliveryIncompleteText([line]),
      });
      return;
    }

    if (verdict.failed) {
      delete group.deliveryChecks;
      delete group.blockedSince;
      // Копия не прочлась (каталог занят, сбой git на миг) — не сдача сразу, а
      // новая сверка через `DELIVERY_RETRY_MS` (трасса автономии 24.10, §2).
      const unread = serverText('split-delivery-local-failed', {
        reason: verdict.failed.slice(0, 300),
      });
      if (this.retryLater(record, group, 'verify', [unread])) return;
      this.settle(record, group, {
        ...withoutMr(outcome),
        status: 'failed',
        error: deliveryIncompleteText(group.deliveryMissing ?? [unread]),
      });
      return;
    }

    // Сеть или доступ: факт неизвестен, а не отрицателен — ждём и спрашиваем
    // снова. Короткие попытки кончились — удалённый лежит (журнал 101: GitLab
    // отдавал 502 11 минут, и группа, не сумевшая отправить ветку, считалась
    // сделанной): группа «заблокирована сервисом», панель проверяет его реже и,
    // когда он ответит, доводит доставку обычным путём — напоминанием группе.
    // Кончился и этот запас — группа сдаётся с причиной, а не висит.
    if (verdict.unreachable) {
      // Удалённый отказал в доступе — это не сеть: ждать четыре часа нечего,
      // и агенту это не починить. Пункт «нужен человек» карточке остановки.
      if (remoteAuthFailure(verdict.unreachable)) {
        const line = serverText('delivery-human-credentials', {
          what: verdict.unreachable.replace(/\s+/g, ' ').trim().slice(0, 200),
        });
        delete group.deliveryChecks;
        delete group.blockedSince;
        group.deliveryMissing = [line];
        this.settle(record, group, {
          ...withoutMr(outcome),
          status: 'failed',
          error: deliveryIncompleteText([line]),
        });
        return;
      }
      const checks = (group.deliveryChecks ?? 0) + 1;
      const blocked = checks > DELIVERY_RECHECK_MS.length;
      const delay =
        DELIVERY_RECHECK_MS[checks - 1] ??
        (checks - DELIVERY_RECHECK_MS.length <= DELIVERY_BLOCKED_PROBES
          ? DELIVERY_BLOCKED_PROBE_MS
          : undefined);
      if (delay !== undefined) {
        group.deliveryChecks = checks;
        if (blocked) group.blockedSince ??= this.now().toISOString();
        const reason = verdict.unreachable;
        group.deliveryMissing = [
          blocked
            ? serverText('split-delivery-remote-down', {
                since: group.blockedSince ?? '',
                minutes: DELIVERY_BLOCKED_PROBE_MS / 60_000,
                reason,
              })
            : serverText('split-delivery-remote-silent', { reason }),
        ];
        this.deps.store.set(record);
        again(settled, delay);
        return;
      }
      delete group.deliveryChecks;
      delete group.blockedSince;
      const silent = serverText('split-delivery-unverifiable', {
        checks,
        reason: verdict.unreachable,
      });
      if (this.retryLater(record, group, 'verify', [silent])) return;
      this.settle(record, group, {
        ...withoutMr(outcome),
        status: 'failed',
        error: deliveryIncompleteText(group.deliveryMissing ?? [silent]),
      });
      return;
    }
    delete group.blockedSince;
    delete group.deliveryChecks;

    // MR найден по голове ветки — он на карточке сразу, а не после того, как
    // группа досдаст остальное: иначе кнопка MR и «MR влит» жили только у
    // групп без единого пробела, а ссылка остальных тонула в хвосте ответа.
    if (verdict.mr && verdict.mr !== group.mr) {
      group.mr = verdict.mr;
      this.deps.store.set(record);
    }

    // Описание MR не прочитать — не повод держать группу, но человек должен
    // знать, что эту часть готовности панель не проверила (аудит 25.09, L110).
    if (verdict.descriptionUnchecked && verdict.mr) {
      this.deps.notify?.(record.parentChatId, {
        kind: 'notice',
        code: 'deliveryUnchecked',
        text: serverText('split-delivery-description-unchecked-notice', {
          group: group.title,
          mr: verdict.mr,
        }),
        textCode: 'split-delivery-description-unchecked-notice',
        textParams: { group: group.title, mr: verdict.mr },
      });
    }
    // Вердикт блока «Тесты» — на группу: хаб показывает, чем проверена работа.
    if (verdict.tests) {
      group.testsVerdict = verdict.tests;
      this.deps.store.set(record);
    }
    // Готовность по следам звеньев — вместе с фактами git (аудит 25.09, L110).
    // След требований (U2): пункт слов владельца без отчёта или с «fail» держит
    // группу так же, как незапушенная ветка, — досдаёт его напоминание.
    verdict = {
      ...verdict,
      missing: [
        ...verdict.missing,
        ...stageTraceGaps(group.stageTrace),
        ...ownerCoverageGaps(group.sieveRows, hasOwnerRequest(record.proposal.shared)),
      ],
    };
    // Сработавшее сито — блокер, пойманный до MR: в счёт панели раз на группу
    // и класс, сколько бы напоминаний ни понадобилось.
    const fresh = (verdict.sieveClasses ?? []).filter(
      (cls) => !(group.sieveCaught ?? []).includes(cls),
    );
    if (fresh.length > 0) {
      group.sieveCaught = [...(group.sieveCaught ?? []), ...new Set(fresh)];
      this.deps.store.set(record);
      try {
        this.deps.sieves?.caught([...new Set(fresh)]);
      } catch (error) {
        this.deps.log('split conveyor: sieve tally failed', error);
      }
    }

    // Заметки (живое сито «не проверено», красное не из-за ветки) — на
    // карточку, а не в пробелы: группу они не держат (решение владельца 23.10).
    if (verdict.notes?.length) group.deliveryNotes = verdict.notes;
    else delete group.deliveryNotes;

    if (verdict.missing.length === 0) {
      this.deliveryBusy.delete(`${parentChatId}#${index}`);
      delete group.deliveryRetry;
      delete group.deliveryMissing;
      delete group.deliveryNudges;
      delete group.deliveryNudgeKey;
      delete group.deliveryNudgeStage;
      delete group.deliveryHistory;
      delete group.deliveryEscalatedAt;
      delete group.deliveryEscalatedAfter;
      if (verdict.notes?.length) {
        const params = { group: group.title, notes: verdict.notes.join('; ') };
        this.deps.notify?.(record.parentChatId, {
          kind: 'notice',
          code: 'deliveryUnchecked',
          text: serverText('split-delivery-notes-notice', params),
          textCode: 'split-delivery-notes-notice',
          textParams: params,
        });
      }
      this.settle(record, group, {
        ...withoutMr(outcome),
        status: 'done',
        ...(verdict.mr ? { mr: verdict.mr } : {}),
      });
      return;
    }

    // Служебная ссылка MR у GitLab появляется через секунды после push: одна
    // повторная сверка до того, как тратить ход группы на напоминание.
    if (!settled) {
      again(true, DELIVERY_SETTLE_MS);
      return;
    }

    // Группа сама сказала, что её держит то, что можно только человеку
    // (`HUMAN_ONLY_LINE`): напоминание и разбор этого не сдвинут — стоп с
    // пунктами «нужен человек» первыми, карточка показывает их отдельно.
    const human = outcome.humanAsks ?? [];
    if (human.length > 0) {
      const lines = human.map((ask) =>
        serverText(HUMAN_CODES[ask.kind], { what: ask.what.slice(0, 200) }),
      );
      delete group.deliveryNudges;
      delete group.deliveryNudgeKey;
      delete group.deliveryNudgeStage;
      group.deliveryMissing = [...lines, ...verdict.missing];
      this.settle(record, group, {
        ...withoutMr(outcome),
        status: 'failed',
        error: deliveryIncompleteText(group.deliveryMissing),
      });
      return;
    }

    group.deliveryMissing = verdict.missing;
    // Счёт напоминаний — на стадию (D3 разбора остановок 23.10): напоминание,
    // ушедшее в сессию работы (ей пуш и MR закрыты), съедало запас доставки,
    // и группа падала после одного слова в самой доставке.
    const stageNow = this.deps.delivery?.stage?.(group);
    if (group.deliveryNudgeStage && stageNow && stageNow !== group.deliveryNudgeStage) {
      delete group.deliveryNudges;
      delete group.deliveryNudgeKey;
    }
    const nudges = group.deliveryNudges ?? 0;
    // Напоминания идут, пока группа движется (23.10): сдаётся только то
    // напоминание, после которого и голова ветки, и пробелы те же, что были
    // при нём, — или потолок `MAX_DELIVERY_NUDGES`.
    const key = deliveryProgressKey(verdict.head, verdict.missing);
    const stalled = group.deliveryNudgeKey === key;
    const capped = nudges >= MAX_DELIVERY_NUDGES;
    const escalated = Boolean(group.deliveryEscalatedAt);
    if (group.chatId && group.path) {
      // Встали или кончились напоминания — не сдаваться, а один раз отдать
      // пробелы с их историей новому разговору на сильной модели (решение
      // владельца 23.10: «решение за вами» — не обычный путь доставки).
      const sent =
        !stalled && !capped
          ? this.deliveryWord(record, group, verdict)
          : escalated
            ? undefined
            : this.escalateDelivery(record, group, verdict);
      // Разговор группы занят в миг нового разговора доставки — сверить снова
      // после хода, а не сдаться с разбором, который так и не ушёл (§2.2).
      const busyKey = `${parentChatId}#${index}`;
      const busy = (this.deliveryBusy.get(busyKey) ?? 0) + 1;
      if (sent === 'busy' && busy <= DELIVERY_BUSY_RECHECKS) {
        this.deliveryBusy.set(busyKey, busy);
        group.deliveryMissing = verdict.missing;
        this.deps.store.set(record);
        again(true, DELIVERY_BUSY_RECHECK_MS);
        return;
      }
      this.deliveryBusy.delete(busyKey);
      if (sent === 'busy') {
        // Занят все сверки подряд: слово не ушло ни разу — причина пунктом и
        // повтор панели (`verify` — снова сверка и новая доставка), а не сдача
        // одними пробелами, которую карточка читала «закроет агент».
        const lines = [
          serverText('split-delivery-busy', { checks: DELIVERY_BUSY_RECHECKS }),
          ...verdict.missing,
        ];
        group.deliveryMissing = lines;
        if (this.retryLater(record, group, 'verify', lines)) return;
        this.settle(record, group, {
          ...withoutMr(outcome),
          status: 'failed',
          error: deliveryIncompleteText(group.deliveryMissing),
        });
        return;
      }
      if (sent === 'sent' || sent === 'queued') {
        // Старт хода зовёт `onChainResumed` изнутри слова: запись в хранилище
        // уже новее этой (статус «работает», чат группы — новый разговор
        // доставки). Счёт кладётся в неё, а не затирает её прежней копией.
        const latest = this.deps.store.get(record.parentChatId);
        const same = latest?.groups.find((item) => item.index === group.index);
        const target = latest && same ? same : group;
        target.deliveryMissing = verdict.missing;
        if (verdict.notes?.length) target.deliveryNotes = verdict.notes;
        else delete target.deliveryNotes;
        if (group.deliveryHistory) target.deliveryHistory = group.deliveryHistory;
        rememberDeliveryRound(target, verdict, this.now());
        if (verdict.mr && verdict.reviewThreads?.length) {
          // Круг наблюдения назначит «готово» (`MrWatch.arm`); переданное он помнит.
          target.mrWatch ??= { cycle: '', checks: 0 };
          noteRelayed(target.mrWatch, verdict.reviewThreads, verdict.mr);
        }
        if (stalled || capped) {
          target.deliveryEscalatedAt = this.now().toISOString();
          // Сколько слов дошло до разбора — их и назовёт причина остановки (RF-EF-04):
          // журнал кругов считает и слова в очереди, и круги после разбора, и
          // обрезан до `DELIVERY_HISTORY_MAX`.
          target.deliveryEscalatedAfter = nudges;
          // Разбор — первое слово нового круга: не сдвинет и он — сдача.
          target.deliveryNudges = 1;
        } else if (sent === 'sent') {
          target.deliveryNudges = nudges + 1;
        }
        // Слово в очереди занятой группы ещё не дошло — в счёт не идёт (D3: у
        // группы стояло «2 из 2» при одном дошедшем напоминании). Ключ — идёт:
        // круг без движения после него всё равно виден.
        target.deliveryNudgeKey = key;
        // Стадия, в которую ушло слово: новая доставка уже перевела группу на свой разговор.
        const stageAfter = this.deps.delivery?.stage?.(target) ?? stageNow;
        if (stageAfter) target.deliveryNudgeStage = stageAfter;
        this.deps.store.set(latest && same ? latest : record);
        return;
      }
    }
    delete group.deliveryNudgeKey;
    // Почему панель перестала напоминать — первым пунктом причины, а сами
    // пробелы остаются списком в `deliveryMissing`.
    const why: string[] = [];
    if (stalled && escalated) {
      // Счёт после разбора начат заново (разбор — первое слово нового круга), и
      // причина говорила «после 1 напоминаний» при шести дошедших (F-115). Число —
      // дошедшие до разбора (RF-EF-04); у записи старше поля — прежняя оценка по
      // журналу кругов (один из них — сам разбор).
      const reminders =
        group.deliveryEscalatedAfter ?? Math.max(nudges, (group.deliveryHistory?.length ?? 0) - 1);
      why.push(serverText('split-delivery-escalation-stalled', { nudges: reminders }));
    } else if (stalled) why.push(serverText('split-delivery-stalled', { nudges }));
    else if (capped) why.push(serverText('split-delivery-nudge-cap', { nudges }));
    // Причина — и пунктом с кодом (F-23): `error` карточка не показывает, а без
    // пункта она читала остановленную группу как «панель доводит сама».
    const lines = [...why, ...verdict.missing];
    group.deliveryMissing = lines;
    // Встали напоминания или разбор — агенты могут снять это сами (решение
    // владельца 23.10): разбор с журналом кругов через `DELIVERY_RETRY_MS`, а не
    // `failed`, которого больше не трогал никто (трасса автономии 24.10, §2).
    const canEscalate = Boolean(group.chatId && group.path && this.deps.delivery?.freshStage);
    if (why.length > 0 && canEscalate && this.retryLater(record, group, 'escalate', lines)) return;
    this.settle(record, group, {
      ...withoutMr(outcome),
      status: 'failed',
      error: deliveryIncompleteText(group.deliveryMissing),
    });
  }

  /**
   * Повтор панели через `DELIVERY_RETRY_MS` вместо сдачи: `verify` — новая
   * сверка фактов (копия не прочлась, удалённый молчал), `escalate` — разбор на
   * сильной модели. Потолок `DELIVERY_RETRY_MAX` на слово человека — дальше
   * `false`, и вызывающий сдаёт группу с пунктом «панель повторила доставку сама»
   * первым (он уже в `deliveryMissing`).
   */
  private retryLater(
    record: SplitPlanRecord,
    group: SplitPlanGroupRecord,
    kind: 'escalate' | 'verify',
    lines: readonly string[],
  ): boolean {
    const count = group.deliveryRetry?.count ?? 0;
    if (count >= DELIVERY_RETRY_MAX) {
      // Счёт и вид остаются: по виду `verify` перезапуск и ответ удалённого
      // ещё раз читают факты сданной группы (`probeDelivery`).
      group.deliveryRetry = { count, kind };
      group.deliveryMissing = [
        serverText('split-delivery-retry-cap', { retries: count }),
        ...lines,
      ];
      return false;
    }
    const at = new Date(this.now().getTime() + DELIVERY_RETRY_MS).toISOString();
    group.deliveryRetry = { count: count + 1, at, kind };
    group.deliveryMissing = [
      serverText('split-delivery-retry', {
        minutes: DELIVERY_RETRY_MS / 60_000,
        attempt: count + 1,
        max: DELIVERY_RETRY_MAX,
      }),
      ...lines,
    ];
    this.deps.store.set(record);
    this.scheduleRetry(record.parentChatId, group.index, at, DELIVERY_RETRY_MS);
    return true;
  }

  /** Таймер повтора; `ms` нет — остаток до срока `at` (после перезапуска). */
  private scheduleRetry(parentChatId: string, index: number, at: string, ms?: number): void {
    const schedule = this.deps.delivery?.schedule ?? setTimeout;
    const delay = ms ?? Math.max(0, Date.parse(at) - this.now().getTime());
    schedule(() => this.retryDelivery(parentChatId, index, at), delay);
  }

  /**
   * Срок повтора настал. Срок не тот (человек продолжил группу, повтор
   * переназначен, перезапуск уже повторил) — молчим: таймер не отменить.
   */
  private retryDelivery(parentChatId: string, index: number, at: string): void {
    const record = this.deps.store.get(parentChatId);
    const group = record?.groups[index];
    const retry = group?.deliveryRetry;
    if (!record || !group || !retry || retry.at !== at) return;
    if (!this.deliveryPending(parentChatId, index)) return;
    delete retry.at;
    delete group.blockedSince;
    if (retry.kind === 'escalate') {
      // Потолок напоминаний без отметки разбора — следующая сверка заводит
      // разбор (`escalateDelivery`) с журналом кругов, а не ещё одно слово.
      group.deliveryNudges = MAX_DELIVERY_NUDGES;
      delete group.deliveryEscalatedAt;
      delete group.deliveryEscalatedAfter;
      delete group.deliveryNudgeKey;
      delete group.deliveryNudgeStage;
      delete group.deliveryChecks;
    } else {
      // Повтор сверки — одна попытка, а не новая лестница в четыре часа:
      // удалённый снова молчит — сразу следующий повтор или потолок.
      group.deliveryChecks = DELIVERY_RECHECK_MS.length + DELIVERY_BLOCKED_PROBES;
    }
    this.deps.store.set(record);
    this.verifyDelivery(
      parentChatId,
      index,
      { status: 'done', ...(group.mr ? { mr: group.mr } : {}) },
      true,
    );
  }

  /**
   * Удалённый ответил на сверке группы `index` (не на пробе): ждущие повтора
   * `verify` того же корня копий сверяются сейчас, а сданные с ним — читаются
   * пробой. Зовётся ПОСЛЕ разбора ответа (`verifyDelivery`): запись
   * вызывающего уже легла, и правка соседа в ней не затрётся. Не чаще
   * `REMOTE_BACK_MS` на группу.
   */
  private remoteBack(parentChatId: string, index: number): void {
    const source = this.deps.store.get(parentChatId);
    if (!source) return;
    const root = copyRootOf(source);
    const now = this.now().getTime();
    for (const record of Object.values(this.deps.store.all())) {
      if (copyRootOf(record) !== root) continue;
      for (const group of record.groups) {
        if (record.parentChatId === parentChatId && group.index === index) continue;
        const key = `${record.parentChatId}#${group.index}`;
        const pending = group.deliveryRetry?.kind === 'verify' && group.deliveryRetry.at;
        if (!pending && !probeable(group)) continue;
        if (now - (this.remoteBackAt.get(key) ?? -Infinity) < REMOTE_BACK_MS) continue;
        this.remoteBackAt.set(key, now);
        if (pending) this.retryDelivery(record.parentChatId, group.index, pending);
        else this.probeDelivery(record.parentChatId, group.index);
      }
    }
  }

  /**
   * Сданная на сверке группа (`verify`: копия не прочлась, удалённый молчал) —
   * чтение фактов без слова группе: доставлено чисто — `done`, иначе тишина.
   * Ни напоминания, ни разбора: сданную группу продолжает только человек.
   */
  private probeDelivery(parentChatId: string, index: number): void {
    const delivery = this.deps.delivery;
    const record = this.deps.store.get(parentChatId);
    const group = record?.groups[index];
    if (!delivery || !record || !group || !probeable(group)) return;
    void delivery
      .facts(group, group.mr, copyRootOf(record), claimedBranches(record, index))
      .then((verdict) => {
        const fresh = this.deps.store.get(parentChatId);
        const same = fresh?.groups[index];
        if (!fresh || !same || !probeable(same) || verdict.failed || verdict.unreachable) return;
        const gaps = [
          ...verdict.missing,
          ...stageTraceGaps(same.stageTrace),
          ...ownerCoverageGaps(same.sieveRows, hasOwnerRequest(fresh.proposal.shared)),
        ];
        if (gaps.length > 0) return;
        this.deps.log(`split conveyor: group «${same.title}» found delivered on a probe`);
        for (const field of DELIVERY_STATE_FIELDS) delete same[field];
        if (verdict.notes?.length) same.deliveryNotes = verdict.notes;
        this.settle(fresh, same, { status: 'done', ...(verdict.mr ? { mr: verdict.mr } : {}) });
      })
      .catch((error: unknown) => {
        this.deps.log('split conveyor: delivery probe failed', error);
      });
  }

  /**
   * Слово доставки группе. Сессии, которой MR не открыть (ревью, план), — не
   * напоминание, а новый разговор стадией доставки: живая группа 23.10 четыре
   * раза получила «откройте MR» в сессию ревью без `create_merge_request`.
   * Напоминание не ушло (разговор не продолжить) — тоже новая доставка.
   */
  private deliveryWord(
    record: SplitPlanRecord,
    group: SplitPlanGroupRecord,
    verdict: DeliveryVerdict,
  ): FreshDelivery | undefined {
    const delivery = this.deps.delivery;
    const prompt = this.withIdentity(
      record,
      group,
      deliveryNudgePrompt(group.branch, verdict.missing, verdict.notes),
    );
    const fresh = (): FreshDelivery | undefined =>
      this.freshDelivery(record, group, prompt, 'deliver');
    const stage = delivery?.stage?.(group);
    if (stage && DELIVERY_READ_ONLY_STAGES.has(stage)) {
      const started = fresh();
      // Занят — ждать хода, а не слать «откройте MR» в очередь сессии, где MR
      // не открыть (тот же круг впустую, ради которого новая доставка и есть).
      if (started === 'sent' || started === 'queued' || started === 'busy') return started;
    }
    const sent = delivery?.nudge(group, prompt);
    if (sent === 'sent' || sent === 'queued') return sent;
    return fresh() ?? sent;
  }

  /** Разбор пробелов новым разговором на сильной модели — один раз на круг доставки. */
  private escalateDelivery(
    record: SplitPlanRecord,
    group: SplitPlanGroupRecord,
    verdict: DeliveryVerdict,
  ): FreshDelivery | undefined {
    const nudges = group.deliveryNudges ?? 0;
    const stalled = group.deliveryNudgeKey === deliveryProgressKey(verdict.head, verdict.missing);
    const prompt = this.withIdentity(
      record,
      group,
      deliveryEscalationPrompt({
        branch: group.branch,
        missing: verdict.missing,
        ...(verdict.notes?.length ? { notes: verdict.notes } : {}),
        history: group.deliveryHistory ?? [],
        reason: stalled ? 'stalled' : 'cap',
        nudges,
      }),
    );
    return this.freshDelivery(record, group, prompt, 'escalate');
  }

  private freshDelivery(
    record: SplitPlanRecord,
    group: SplitPlanGroupRecord,
    prompt: string,
    mode: FreshDeliveryMode,
  ): FreshDelivery | undefined {
    const start = this.deps.delivery?.freshStage;
    if (!start) return undefined;
    try {
      return start(record, group, prompt, mode);
    } catch (error) {
      this.deps.log(`split conveyor: fresh delivery (${mode}) failed`, error);
      return 'refused';
    }
  }

  /**
   * После перезапуска панели: проверки доставки, оборванные вместе с прежним
   * процессом, идут заново — иначе группа стояла бы «проверяю» вечно, а
   * ждавшие её — вместе с ней.
   */
  recoverDeliveryChecks(): void {
    for (const record of Object.values(this.deps.store.all())) {
      // Перепроверка, отданная сессии, но не начатая, жила в очереди прежнего
      // процесса и умерла с ним — иначе «Перепроверяется…» навсегда (ревью R2).
      const lost = record.groups.filter(
        (group) => group.recheckRequestedAt && !group.parked?.recheck && !group.recheckRunning,
      );
      for (const group of lost) dropRecheck(group);
      // Так же умерло «Продолжить» из очереди сессии — кнопка снова работает.
      const queued = record.groups.filter((group) => group.continueQueuedAt);
      for (const group of queued) delete group.continueQueuedAt;
      if (lost.length > 0 || queued.length > 0) this.deps.store.set(record);
      for (const group of record.groups) {
        // Таймер повтора умер с процессом. Сверка (`verify`) — сейчас: она только
        // читает факты. Разбор (`escalate`) — в свой срок: без него перезапуск
        // заводил бы новый разговор на сильной модели при каждом старте панели.
        const retryAt = group.deliveryRetry?.at;
        if (retryAt && group.status === 'awaiting' && group.waitingFor === 'delivery') {
          if (group.deliveryRetry?.kind === 'escalate') {
            this.scheduleRetry(record.parentChatId, group.index, retryAt);
          } else this.retryDelivery(record.parentChatId, group.index, retryAt);
          continue;
        }
        if (probeable(group)) {
          this.probeDelivery(record.parentChatId, group.index);
          continue;
        }
        if (group.status === 'awaiting' && group.waitingFor === 'delivery') {
          this.verifyDelivery(record.parentChatId, group.index, {
            status: 'done',
            ...(group.mr ? { mr: group.mr } : {}),
          });
        }
      }
    }
  }

  /**
   * Ветка и задачи группы связи — первой строкой звену, которое планировщик
   * заводит за ней (журнал 98). Нет плана или группы — ничего.
   */
  identityOf(link: ChatLink): string | undefined {
    if (!link.parentChatId) return undefined;
    const record = this.deps.store.get(link.parentChatId);
    if (!record) return undefined;
    const group =
      (typeof link.groupIndex === 'number'
        ? record.groups.find((item) => item.index === link.groupIndex)
        : undefined) ?? record.groups.find((item) => link.branch && item.branch === link.branch);
    return group ? this.identity(record, group) || undefined : undefined;
  }

  /**
   * Группа связи доводит работу до MR — планировщик заведёт за правками звено
   * доставки (журнал 59a). Нет плана или группы — нет и доставки.
   */
  delivers(link: ChatLink): boolean {
    return this.groupOfLink(link)?.deliver === true;
  }

  /**
   * «Доставка на Sonnet» группы связи, выбранная человеком на карточке (F-12).
   * Нет выбора — `undefined`: доставку решает общий рычаг экономии.
   */
  sonnetDeliverOf(link: ChatLink): boolean | undefined {
    const group = this.groupOfLink(link);
    if (!group || !link.parentChatId) return undefined;
    return this.deps.store.get(link.parentChatId)?.request.sonnetDeliver?.[String(group.index)];
  }

  /**
   * Звено доставки ещё впереди — его заведёт планировщик (L3: работу доставки
   * звену не делать). Группа уже ждёт доставки по фактам git — цепочка кончилась,
   * звена не будет, и любой следующий ход в её чат (напоминание «отправь ветку,
   * открой MR», ответ человека) доставляет сам (F-04 ревью П1: запрет пуша висел
   * и на ходе напоминания, и напоминания сгорали впустую).
   */
  deliverAhead(link: ChatLink): boolean {
    return groupDeliverAhead(this.groupOfLink(link));
  }

  private groupOfLink(link: ChatLink): SplitPlanGroupRecord | undefined {
    const record = link.parentChatId ? this.deps.store.get(link.parentChatId) : undefined;
    return (
      record?.groups.find((item) => item.index === link.groupIndex) ??
      record?.groups.find((item) => link.branch && item.branch === link.branch)
    );
  }

  /** Строка «ветка + задачи» группы (журнал 98); пусто — сказать нечего. */
  private identity(record: SplitPlanRecord, group: SplitPlanGroupRecord): string {
    const tasks = record.proposal.groups[group.index]?.tasks ?? [];
    return groupIdentityLine(group.branch, trackerKeys(tasks.join('\n')));
  }

  /** Сообщение панели в чат группы — с её веткой и задачами первой строкой. */
  private withIdentity(
    record: SplitPlanRecord,
    group: SplitPlanGroupRecord,
    prompt: string,
  ): string {
    const line = this.identity(record, group);
    return line ? `${line}\n\n${prompt}` : prompt;
  }

  /**
   * Настройка «сколько групп разом» на проекте сменилась (журнал 25): очередь
   * сама двигается только концом чьей-то цепочки, и поднятый потолок не значил
   * ничего, пока хоть одна группа не доработает. Разобранные планы проекта
   * добирают свободные места сразу. Опущенный потолок идущих не останавливает.
   */
  kickProject(projectPath: string): void {
    const target = normalizePath(projectPath);
    for (const record of Object.values(this.deps.store.all())) {
      if (!record.triage || !record.projectPath) continue;
      if (normalizePath(record.projectPath) !== target) continue;
      if (!record.groups.some((group) => group.status === 'pending')) continue;
      void this.launchReady(record).catch((error) => {
        this.deps.log('split conveyor: launch after settings change failed', error);
      });
    }
  }

  /**
   * Процесс группы оборвался посреди хода (WP1c; журнал 39, 110): CLI умер, не
   * дописав ход, и закрывающего ответа нет. Раньше группа так и стояла
   * «работает», а ждавшие её — вместе с ней. Теперь она «прервана», место
   * держит, и панель сама продолжает её, пока не кончились попытки.
   */
  onChainInterrupted(link: ChatLink): void {
    const record = this.deps.store.get(link.parentChatId);
    if (!record) return;
    const group = this.groupOf(record, link, ['started', 'background']);
    if (!group) return;
    this.interrupt(record, group);
    this.autoResume(record.parentChatId, group.index);
  }

  /**
   * Сторож повисших групп (`split-stall.ts`): группа молчит дольше любого
   * законного вызова, её процесс уже снят — дальше путь оборванного хода.
   * `undefined` — группа за это время перестала «работать», трогать нечего.
   */
  interruptStalled(parentChatId: string, index: number): { resumed: boolean } | undefined {
    const record = this.deps.store.get(parentChatId);
    const group = record?.groups.find((item) => item.index === index);
    if (!record || !group || (group.status !== 'started' && group.status !== 'background')) {
      return undefined;
    }
    this.interrupt(record, group);
    return { resumed: this.autoResume(parentChatId, index) };
  }

  /**
   * После перезапуска панели, ПОСЛЕ усыновления живых прогонов: группа, чей
   * прогон не пережил перезапуск, прервана. Сюда же — ждавшая повтора: таймер
   * повтора жил в памяти прежнего процесса и уже не сработает.
   */
  recoverInterruptedGroups(
    alive: (group: SplitPlanGroupRecord) => boolean,
  ): { parentChatId: string; event: ChatEvent }[] {
    const notices: { parentChatId: string; event: ChatEvent }[] = [];
    for (const record of Object.values(this.deps.store.all())) {
      const cut: SplitPlanGroupRecord[] = [];
      for (const group of record.groups) {
        const lost =
          group.status === 'started' ||
          group.status === 'background' ||
          (group.status === 'awaiting' && group.waitingFor === 'retry');
        if (!lost || alive(group)) continue;
        this.interrupt(record, group);
        cut.push(group);
      }
      if (cut.length === 0) continue;
      const resumed = cut.filter((group) =>
        this.autoResume(record.parentChatId, group.index),
      ).length;
      const params = {
        groups: cut.map((group) => `«${group.title}»`).join(', '),
        resumed: String(resumed),
      };
      notices.push({
        parentChatId: record.parentChatId,
        event: {
          kind: 'notice',
          code: 'groupsInterrupted',
          text: serverText('split-groups-interrupted-notice', params),
          textCode: 'split-groups-interrupted-notice',
          textParams: params,
        },
      });
    }
    return notices;
  }

  /**
   * «Продолжить» человека (WP1c+): оборванные группы разделения — все или
   * одна — продолжаются с восстановлением состояния. Счёт самостоятельных
   * продолжений начинается заново: человек сказал пробовать ещё.
   */
  resumeInterrupted(
    parentChatId: string,
    index?: number,
  ): { resumed: number[]; refused: number[] } {
    const outcome = { resumed: [] as number[], refused: [] as number[] };
    const record = this.deps.store.get(parentChatId);
    if (!record) return outcome;
    for (const group of record.groups) {
      if (index !== undefined && group.index !== index) continue;
      if (group.status !== 'awaiting' || group.waitingFor !== 'interrupted') continue;
      const current = this.deps.store.get(parentChatId);
      const fresh = current?.groups[group.index];
      if (!current || !fresh) continue;
      (this.resumeGroup(current, fresh, 0) ? outcome.resumed : outcome.refused).push(group.index);
    }
    return outcome;
  }

  /** Группа прервана: ждёт продолжения, место держит (без запуска очереди). */
  private interrupt(record: SplitPlanRecord, group: SplitPlanGroupRecord): void {
    this.apply(group, { status: 'awaiting', waitingFor: 'interrupted' });
    group.interruptedAt = this.now().toISOString();
    this.deps.store.set(record);
  }

  /** Самостоятельное продолжение, пока не кончились попытки. */
  private autoResume(parentChatId: string, index: number): boolean {
    const record = this.deps.store.get(parentChatId);
    const group = record?.groups[index];
    if (!record || !group) return false;
    const done = group.interruptResumes ?? 0;
    if (done >= MAX_INTERRUPT_RESUMES) return false;
    return this.resumeGroup(record, group, done + 1);
  }

  private resumeGroup(
    record: SplitPlanRecord,
    group: SplitPlanGroupRecord,
    count: number,
  ): boolean {
    if (!this.deps.resume || !group.chatId || !group.path) return false;
    const previous = group.interruptResumes;
    // Счёт — ДО старта: старт тут же зовёт `onChainResumed`, и запись после
    // него уже меняет он.
    group.interruptResumes = count;
    this.deps.store.set(record);
    const prompt = this.withIdentity(record, group, interruptResumePrompt(group.branch, group));
    if (this.deps.resume(group, prompt) !== 'refused') return true;
    const fresh = this.deps.store.get(record.parentChatId);
    const same = fresh?.groups[group.index];
    if (fresh && same) {
      if (previous === undefined) delete same.interruptResumes;
      else same.interruptResumes = previous;
      this.deps.store.set(fresh);
    }
    return false;
  }

  /**
   * Освободилось место: сперва дождавшиеся предшественников (их работа уже
   * отстояла очередь раз), потом готовые из очереди.
   */
  private async launchNext(record: SplitPlanRecord): Promise<void> {
    // Отложенные продолжения (журнал 81, WP1j) — первыми: их группа уже
    // отстояла очередь и сделала работу, ей не хватило только места.
    this.drainParked(record.parentChatId);
    const fresh = this.deps.store.get(record.parentChatId) ?? record;
    await this.launchUnblocked(fresh);
    await this.launchReady(fresh);
  }

  /**
   * В чате группы снова идёт прогон — человек ответил, продолжил ребёнка или
   * панель повторила упавший ход: группа снова «работает» (Д3). Итог прошлого
   * хода больше не правда; ждавших, уже отпущенных, это не возвращает.
   *
   * Место под потолком ждавшая группа держала (`occupied`, M7): ответ человека
   * числа работающих не поднимает. Сверх потолка её продолжает только сам
   * человек — «Продолжить» с паузы с согласием или новым сообщением в чат
   * закрытой группы: остановить уже идущий разговор ради очереди нельзя.
   *
   * `chatId` — чат, в котором пошёл прогон: он и есть теперь чат группы. У
   * группы с конвейером первым был чат ПЛАНА, и без этой записи слово родителя
   * (Д7) и сводка ему (Д6) вели в план, а не в работу (живой прогон 23.09).
   */
  onChainResumed(link: ChatLink, chatId?: string): void {
    const record = this.deps.store.get(link.parentChatId);
    // План отменён — его чаты живут дальше обычными разговорами, и прогон в
    // них группу не воскрешает: иначе отменённый план снова держал бы замок.
    if (!record || record.cancelledAt) return;
    const group = this.groupOf(record, link, [
      'started',
      'awaiting',
      'background',
      'paused',
      'done',
      'failed',
    ]);
    if (!group) return;
    // Чат плана возвращает группу в работу только ответом на его вопрос: первый
    // ход плана группу уже застал работающей, а после плана группой ведает чат
    // работы — сообщение в старый чат плана её статуса не трогает.
    if (link.stage === 'plan' && (link.plannedAt || group.status !== 'awaiting')) return;
    traceStage(group, link, this.now());
    if (chatId) group.chatId = chatId;
    group.status = 'started';
    delete group.waitingFor;
    delete group.doneAt;
    delete group.error;
    // Пауза и ожидание лимита — про прошлый ход: группа снова работает.
    // Отложенное продолжение не стирается — оно уйдёт ей после этого хода.
    delete group.pausedAt;
    delete group.limitUntil;
    // Проверка доставки прошлого хода кончилась вместе с ним: следующая
    // считает попытки и простой сервиса заново.
    delete group.deliveryChecks;
    delete group.blockedSince;
    // Принимали прошлую работу: новый ход её меняет, отметка снимается.
    delete group.acceptedAt;
    delete group.markedDone;
    // Проверяли тоже прошлую: зелёная отметка уходит, идущая перепроверка — нет.
    delete group.recheckedAt;
    // Слово перепроверки уже у сессии — этот ход и есть перепроверка.
    if (group.recheckSentAt) group.recheckRunning = true;
    // Отложенное «Продолжить» дошло — этот ход и есть оно.
    delete group.continueQueuedAt;
    delete group.droppedAt;
    this.deps.store.set(record);
  }

  /** Запись группы по номеру из связи (Д12), у старых связей — по ветке. */
  private groupOf(
    record: SplitPlanRecord,
    link: ChatLink,
    statuses: readonly SplitPlanRecord['groups'][number]['status'][],
  ): SplitPlanRecord['groups'][number] | undefined {
    const fit = (item: SplitPlanRecord['groups'][number]) => statuses.includes(item.status);
    if (typeof link.groupIndex === 'number') {
      const byIndex = record.groups.find((item) => item.index === link.groupIndex);
      if (byIndex) return fit(byIndex) ? byIndex : undefined;
    }
    if (!link.branch) return undefined;
    return record.groups.find((item) => fit(item) && item.branch === link.branch);
  }

  /**
   * Ответ человека на вопрос разбора: группа больше не держится. Если она ещё и
   * ждёт предшественников — остаётся ждать, ответ уедет с ней; иначе стартует
   * сейчас. Возвращает, что завелось (пусто — ждёт).
   */
  async answerHold(parentChatId: string, index: number, answer: string): Promise<TaskSplitResult> {
    const record = this.deps.store.get(parentChatId);
    const group = record?.groups[index];
    if (!record || !group || group.status !== 'held') {
      throw coded(
        new Error('Группа не ждёт ответа: вопроса нет или на него уже ответили'),
        'split-hold-not-waiting',
      );
    }
    group.holdAnswer = answer;
    group.status = this.unmet(record, group).length > 0 ? 'waiting' : 'pending';
    this.deps.store.set(record);

    const ready = await this.launchReady(record);
    const unblocked = await this.launchUnblocked(record);
    return {
      chats: [...ready.chats, ...unblocked.chats],
      failures: [...ready.failures, ...unblocked.failures],
    };
  }

  /**
   * Человек отпускает группу, не дожидаясь предшественников.
   *
   * Единственная дверь у группы со статусом `waiting`: ответ на вопрос разбора
   * работает только с `held`, а цепочка предшественника может не кончиться
   * никогда — его остановили, чат удалили, прогон умер вместе с панелью. До
   * 18.09.2026 такая группа стояла вечно и сдвинуть её было нечем.
   *
   * Панель здесь ничего не решает за человека и ничего не скрывает от агента:
   * копия по-прежнему отводится от ветки предшественника, а в задание уезжает
   * прямым текстом, что та работа не закончена (`contextFor` → `unfinished`).
   */
  async release(parentChatId: string, index: number): Promise<TaskSplitResult> {
    const record = this.deps.store.get(parentChatId);
    const group = record?.groups[index];
    if (!record || !group || group.status !== 'waiting') {
      throw coded(
        new Error('Группа не ждёт предшественников: отпускать нечего'),
        'split-release-not-waiting',
      );
    }
    group.released = true;
    this.deps.store.set(record);
    return this.launchUnblocked(record);
  }

  /**
   * Убрать копию закрытой группы (Д19) — только по кнопке человека: панель сама
   * не удаляет ничего. Без этого копии копились десятками (в живом проекте — 30), и
   * ветки `…-2`, заведённые впустую, висели на `main` годами.
   *
   * Git здесь, как и запуск, снаружи (`remove`): домен решает только, можно ли.
   * Нельзя — группа не закрыта, копии нет или её уже убрали, и ещё одно: в той
   * же копии живёт другая, не закрытая группа (ревью и правки MR делят копию).
   *
   * Группа прошлого разделения (`retiredGroups`, F5.2) адресуется ключами чата: номер
   * у неё от старого плана и совпадает с номером новой группы. Её статус застыл
   * вместе со старым планом — закрытости от неё не ждём; работающий в копии
   * процесс маршрут отсекает сам.
   */
  async cleanup(
    parentChatId: string,
    target: number | { chatIds: readonly string[] },
    remove: (target: {
      projectPath: string;
      path: string;
      branch: string;
      chatId?: string;
    }) => Promise<SplitGroupCleaned['branch']>,
  ): Promise<SplitGroupCleaned> {
    const record = this.deps.store.get(parentChatId);
    const retired = typeof target !== 'number';
    const group = retired
      ? record?.retiredGroups?.find((item) => item.chatId && target.chatIds.includes(item.chatId))
      : record?.groups[target];
    const closed = (status: string): boolean => status === 'done' || status === 'failed';
    if (!record || !group || !group.path || group.cleaned || (!retired && !closed(group.status))) {
      throw coded(
        new Error('Убирать нечего: группа не закрыта, копии нет или она уже убрана'),
        'split-cleanup-nothing',
      );
    }
    const path = group.path;
    const norm = (value: string): string => value.replace(/\\/g, '/').toLowerCase();
    const shared = record.groups.some(
      (other) =>
        other !== group && other.path && norm(other.path) === norm(path) && !closed(other.status),
    );
    if (shared) {
      throw coded(
        new Error('В этой копии ещё работает другая группа — уберите копию, когда закроется и она'),
        'split-cleanup-shared',
      );
    }
    const branch = await remove({
      // Копии заведены от верха репозитория — там их и убирать (m6).
      projectPath: copyRootOf(record),
      path,
      branch: group.branch,
      ...(group.chatId ? { chatId: group.chatId } : {}),
    });
    const cleaned = { at: this.now().toISOString(), branch };
    group.cleaned = cleaned;
    // `remove` шёл секунды и минуты: за это время запись могли заменить — новое
    // «Разделить» у того же родителя, переезд к продолжению, откат состояния.
    // Пишем ту, что правда сейчас (F-42), а не взятую до ожидания: старая легла
    // бы поверх нового разделения. Записи не стало — не воскрешаем.
    const live = this.deps.store.get(parentChatId);
    if (!live) return cleaned;
    // Копии больше нет ни у кого, кто её делил: иначе у соседа по ней — из
    // того же или прошлого плана — осталась бы кнопка уборки несуществующего.
    for (const other of [...live.groups, ...(live.retiredGroups ?? [])]) {
      if (other.path && !other.cleaned && norm(other.path) === norm(path)) other.cleaned = cleaned;
    }
    this.deps.store.set(live);
    return cleaned;
  }

  /**
   * Завести группы заново из сохранённого итога разбора — без второго разбора.
   *
   * Нужен, когда группы стартовали НЕ ТАМ (живой прогон 24.09.2026: восемь групп
   * в одном подкаталоге, без копий): разбор на потолке стоит минуты, и его итог
   * верен — неверен был каталог. Незакрытые группы теряют чаты (`discard`
   * снимает связь; прогоны маршрут останавливает до вызова) и встают в очередь
   * заново; закрытые (`done`) не трогаются. Решение человека: панель сама
   * ничего не перезапускает.
   */
  async relaunch(
    parentChatId: string,
    projectPath: string,
    discard: (chatId: string) => void,
  ): Promise<TaskSplitResult> {
    const record = this.deps.store.get(parentChatId);
    if (!record) {
      throw coded(new Error('Разделения нет: перезапускать нечего'), 'split-relaunch-nothing');
    }
    // Отменённый план закрыт человеком (m1): перезапуск поднял бы его группы, а
    // отметка отмены осталась бы — план шёл бы, но ни отменить его, ни продолжить
    // группы, ни увидеть в пульте «Отменить план» было бы нельзя. Путь дальше —
    // новое «Разделить»: замок отменённый план уже не держит.
    if (record.cancelledAt) throw cancelledPlan();
    for (const group of record.groups) {
      if (group.status === 'done' || group.status === 'pending') continue;
      if (group.chatId) discard(group.chatId);
      group.status = 'pending';
      // Всё, что принадлежит прошлой жизни группы (m2): новая жизнь — новые
      // копия, чат, ход, доставка и MR. Остаётся только итог разбора (заметки,
      // ответ на вопрос, `released`) — это решения о плане, а не о жизни.
      for (const key of [
        'chatId',
        'path',
        'base',
        'startedAt',
        'doneAt',
        'error',
        'waitingFor',
        'result',
        'tail',
        'retries',
        'pausedAt',
        'limitUntil',
        'parked',
        'deliver',
        'deliveryMissing',
        'deliveryNudges',
        'deliveryNudgeKey',
        'deliveryNudgeStage',
        'deliveryNotes',
        'deliveryHistory',
        'deliveryEscalatedAt',
        'deliveryEscalatedAfter',
        'deliveryRetry',
        'deliveryChecks',
        'blockedSince',
        'mr',
        'cleaned',
        'mrWatch',
        'acceptedAt',
        'markedDone',
        'recheckRequestedAt',
        'recheckSentAt',
        'recheckRunning',
        'continueQueuedAt',
        'recheckedAt',
        'mrClosed',
        'droppedAt',
        'tickets',
        'humanSteps',
        'interruptedAt',
        'interruptResumes',
        'drift',
      ] as const) {
        delete group[key];
      }
    }
    // Настройки проекта — по-прежнему по его пути; копии — от верха репозитория.
    if (normalizePath(projectPath) !== normalizePath(record.projectPath)) {
      record.copyRoot = projectPath;
    } else delete record.copyRoot;
    this.deps.store.set(record);
    return this.launchReady(record);
  }

  private ticketTrackerOf(record: SplitPlanRecord): string | undefined {
    return this.deps.ticketTracker?.(record.projectPath);
  }

  /**
   * Отметки находок и заводы в полёте (`split-ticket-batch/ticket-marks.ts`):
   * одни слоты у «Завести» строки и у «Опубликовать в Jira» всего списка —
   * двойной клик и публикация рядом не заводят одну находку дважды.
   */
  readonly ticketMarks: SplitTicketMarks;

  /**
   * Завести предложенный тикет в трекере (L277): человек подтвердил в хабе.
   * Заводит `create` (запись в чужой сервис — дело маршрута), конвейер отвечает
   * за «один дефект — одна задача»: уже заведённый ключ возвращается как есть,
   * одновременный второй вызов ждёт первый, а отметка ложится на тот же дефект
   * во всех группах. `create` может не заводить, а прокомментировать уже
   * открытую задачу про то же (R3.6) — тогда ответ `created: false, commented: true`.
   */
  async fileTicket(
    parentChatId: string,
    key: string,
    create: (
      ticket: SplitTicketView,
      projectKey: string,
      groups: string[],
    ) => Promise<TicketFiling>,
  ): Promise<{ key: string; created: boolean; commented?: true }> {
    const record = this.deps.store.get(parentChatId);
    const matches = (record?.groups ?? []).flatMap((group) =>
      (group.tickets ?? [])
        .filter((ticket) => splitTicketKey(ticket) === key)
        .map((ticket) => ({ group, ticket })),
    );
    const first = matches[0];
    if (!record || !first) {
      throw coded(new Error('Такого предложения тикета в разделении нет'), 'split-ticket-missing');
    }
    const filed = matches.find((match) => match.ticket.filed)?.ticket.filed;
    if (filed) return { key: filed.key, created: false };
    const projectKey = this.ticketTrackerOf(record);
    if (!projectKey) {
      throw coded(
        new Error('Трекер у проекта не привязан: завести тикет некуда'),
        'split-ticket-tracker-missing',
      );
    }
    const groups = [...new Set(matches.map((match) => match.group.title))];
    const done = await this.ticketMarks.fileKeys(parentChatId, [key], ([ticket]) =>
      create(ticket ?? first.ticket, projectKey, groups),
    );
    if (done.commented) return { key: done.key, created: false, commented: true };
    return { key: done.key, created: done.created };
  }

  /** Запись для пульта: по любому разговору дерева, новейшая из подходящих. */
  view(chatIds: readonly string[]): SplitPlanView | undefined {
    const records = Object.values(this.deps.store.all())
      .filter((record) => chatIds.includes(record.parentChatId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const record = records[0];
    if (!record) return undefined;
    // Лимит подписки — на весь аккаунт провайдера, а не на запись (журнал 89, m11).
    const limitUntil = this.limitedUntil(providerOf(record));
    return {
      parentChatId: record.parentChatId,
      ...(record.triageChatId ? { triageChatId: record.triageChatId } : {}),
      ...(record.triage ? { triage: record.triage } : {}),
      // Пересечения (Т6) едут в пульт без отметок «о чём уже сказали»: это
      // память сервера о заметках, а не то, что человеку показывают.
      ...(record.overlap
        ? {
            overlap: {
              at: record.overlap.at,
              files: record.overlap.files,
              mergeOrder: record.overlap.mergeOrder,
              counted: record.overlap.counted,
              unread: record.overlap.unread,
            },
          }
        : {}),
      ...(this.ticketTrackerOf(record) ? { ticketTracker: this.ticketTrackerOf(record) } : {}),
      ...(this.deps.tasksConnected?.() ? { jiraTasks: true as const } : {}),
      order: record.order,
      groups: record.groups.map((group) => ({
        index: group.index,
        title: group.title,
        branch: group.branch,
        after: group.after,
        status: group.status,
        ...(group.hold ? { hold: group.hold, ...holdCode(group.hold) } : {}),
        ...(group.holdAnswer ? { holdAnswer: group.holdAnswer } : {}),
        ...(group.chatId ? { chatId: group.chatId } : {}),
        ...(group.path ? { path: group.path } : {}),
        ...(group.base ? { base: group.base } : {}),
        ...(group.error ? { error: group.error, ...errorCodeOf(group.error) } : {}),
        ...(group.waitingFor ? { waitingFor: group.waitingFor } : {}),
        ...(group.result ? { result: group.result } : {}),
        ...(group.tail ? { tail: group.tail } : {}),
        ...(group.mr ? { mr: group.mr } : {}),
        ...(group.retries ? { retries: group.retries } : {}),
        ...(group.deliveryMissing
          ? {
              deliveryMissing: group.deliveryMissing,
              ...deliveryMissingCodesOf(group.deliveryMissing),
            }
          : {}),
        ...(group.deliveryNudges ? { deliveryNudges: group.deliveryNudges } : {}),
        ...(group.deliveryRetry?.at ? { deliveryRetryAt: group.deliveryRetry.at } : {}),
        ...(group.testsVerdict ? { testsVerdict: group.testsVerdict } : {}),
        ...this.groupTokenView(record, group),
        ...watchSignalsView(this.deps.store.watchSignals?.(record.parentChatId, group.index)),
        ...(group.reviewClose ? { reviewClose: group.reviewClose } : {}),
        ...(group.deliver !== undefined ? { deliver: group.deliver } : {}),
        ...(group.interruptedAt ? { interruptedAt: group.interruptedAt } : {}),
        ...(group.interruptResumes ? { interruptResumes: group.interruptResumes } : {}),
        ...(group.cleaned ? { cleaned: group.cleaned } : {}),
        ...(group.pausedAt ? { pausedAt: group.pausedAt } : {}),
        ...(seated(group) ? { seated: true } : {}),
        ...(group.limitUntil ? { limitUntil: group.limitUntil } : {}),
        ...(group.parked ? { parkedAt: group.parked.at } : {}),
        ...(group.acceptedAt ? { acceptedAt: group.acceptedAt } : {}),
        ...(group.markedDone ? { markedDoneAt: group.markedDone.at } : {}),
        ...(group.recheckRequestedAt ? { recheckRequestedAt: group.recheckRequestedAt } : {}),
        ...(group.recheckedAt ? { recheckedAt: group.recheckedAt } : {}),
        ...(group.mrClosed ? { mrClosed: group.mrClosed } : {}),
        ...(record.proposal.groups[group.index]?.review ? { review: true as const } : {}),
        ...(group.droppedAt ? { droppedAt: group.droppedAt } : {}),
        ...(group.tickets?.length ? { tickets: group.tickets } : {}),
        ...(groupTaskKeys(record, group).length ? { taskKeys: groupTaskKeys(record, group) } : {}),
        ...(group.humanSteps?.length ? { humanSteps: group.humanSteps } : {}),
        ...(group.autoNotices?.length ? { autoNotices: group.autoNotices } : {}),
      })),
      ...(limitUntil ? { limitUntil } : {}),
      ...(limitUntil && record.limitWarning ? { limitWarning: true } : {}),
      ...(record.cancelledAt ? { cancelledAt: record.cancelledAt } : {}),
    };
  }

  /** Предшественники, чья цепочка ещё не кончилась. */
  private unmet(record: SplitPlanRecord, group: SplitPlanRecord['groups'][number]): number[] {
    // Отпущенную руками группу не держит никто: человек решил, что ждать не
    // будет, и то, что предшественник не доработал, уезжает ей в заметки.
    if (group.released) return [];
    return group.after.filter((ref) => {
      const dep = record.groups[ref];
      return dep && dep.status !== 'done' && dep.status !== 'failed';
    });
  }

  /**
   * Сколько групп ещё можно завести сейчас. Место держит группа, у которой
   * идёт прогон (`started`), фоновая команда (`background`) или которая ждёт
   * (`awaiting`) — чего угодно, человека тоже (M7): ответ человека стартует
   * прогон в её чате, и отданное очереди место подняло бы число работающих над
   * потолком, а останавливать уже идущий разговор ради очереди нельзя. Пауза
   * место держит тоже (живой прогон 29.09; до него — отдавала, журнал 81a).
   */
  private slots(record: SplitPlanRecord): number {
    const limit = this.deps.parallel?.(record);
    if (!limit || limit < 1) return Number.POSITIVE_INFINITY;
    return Math.max(0, limit - this.occupied(record));
  }

  /** Сколько групп держат место под потолком сейчас. */
  private occupied(record: SplitPlanRecord): number {
    // Ждущая группа место держит, чего бы она ни ждала: проверку доставки, обрыв
    // и сброс лимита (журнал 89) панель продолжит сама, вопрос и решение —
    // человек (M7). К продолжению её место должно быть свободно — иначе оно
    // подняло бы число работающих над потолком.
    // Пауза человека место тоже держит (живой прогон 29.09), кроме паузы из
    // очереди — та места не занимала.
    return record.groups.filter(
      (group) =>
        group.status === 'started' ||
        group.status === 'background' ||
        group.status === 'awaiting' ||
        (group.status === 'paused' && seated(group)),
    ).length;
  }

  /** Номера групп в порядке разбора — очередь стартует в нём. */
  private ordered(record: SplitPlanRecord): SplitPlanRecord['groups'] {
    const position = (index: number): number => {
      const at = record.order.indexOf(index);
      return at < 0 ? record.order.length + index : at;
    };
    return [...record.groups].sort((a, b) => position(a.index) - position(b.index));
  }

  /** Порция без ожиданий: всё, что `pending` и ни от кого не зависит, — сколько влезает. */
  private async launchReady(record: SplitPlanRecord): Promise<TaskSplitResult> {
    // Лимит подписки исчерпан (журнал 81b): старт сгорел бы на первом же вызове
    // модели. Очередь ждёт сброса — его будит `wakeFromLimit`.
    if (this.limitedUntil(providerOf(record))) return { chats: [], failures: [] };
    // Разбор ещё идёт: порядок и места групп решит его блок. Иначе перезапуск
    // панели, пауза или «Убрать» посреди разбора заводили группы, а разбор потом
    // заводил их второй раз (ревью 30.09).
    if (triagePending(record)) return { chats: [], failures: [] };
    const ready = this.ordered(record)
      .filter((group) => group.status === 'pending' && this.unmet(record, group).length === 0)
      .map((group) => group.index)
      .slice(0, this.slots(record))
      .sort((a, b) => a - b);
    if (ready.length === 0) return { chats: [], failures: [] };

    // Группы с ответом человека получают его в заметки — по одной, у каждой
    // свой контекст; остальные — одной порцией.
    const plain = ready.filter((index) => !record.groups[index]?.holdAnswer);
    const answered = ready.filter((index) => record.groups[index]?.holdAnswer);
    const results: TaskSplitResult[] = [];
    if (plain.length > 0) {
      results.push(await this.runPortion(record, plain, undefined, ['pending']));
    }
    for (const index of answered) {
      results.push(
        await this.runPortion(record, [index], this.contextFor(record, index), ['pending']),
      );
    }
    return {
      chats: results.flatMap((result) => result.chats),
      failures: results.flatMap((result) => result.failures),
    };
  }

  /**
   * Группы, дождавшиеся предшественников. По одной: у каждой своя база — ветка
   * ПОСЛЕДНЕГО предшественника по порядку разбора (слить две ветки панель не
   * может, слияние остаётся человеку; остальные предшественники названы в
   * заметках, чтобы агент знал, где искать их правки).
   */
  private async launchUnblocked(record: SplitPlanRecord): Promise<TaskSplitResult> {
    if (triagePending(record)) return { chats: [], failures: [] };
    const results: TaskSplitResult[] = [];
    for (const group of this.ordered(record)) {
      if (group.status !== 'waiting' || this.unmet(record, group).length > 0) continue;
      // Места нет — группа остаётся `waiting` без неудовлетворённых
      // предшественников и стартует со следующим освободившимся местом. Лимит
      // подписки держит её так же — до сброса (журнал 81b).
      if (this.slots(record) === 0 || this.limitedUntil(providerOf(record))) break;
      results.push(
        await this.runPortion(record, [group.index], this.contextFor(record, group.index), [
          'waiting',
        ]),
      );
    }
    return {
      chats: results.flatMap((result) => result.chats),
      failures: results.flatMap((result) => result.failures),
    };
  }

  private contextFor(record: SplitPlanRecord, index: number): SplitGroupContext {
    const group = record.groups[index];
    if (!group) return {};
    const ordered = [...group.after].sort(
      (a, b) => record.order.indexOf(a) - record.order.indexOf(b),
    );
    const predecessors: PredecessorNote[] = ordered
      .map((ref) => record.groups[ref])
      .filter((dep): dep is NonNullable<typeof dep> => Boolean(dep))
      .map((dep) => ({
        title: dep.title,
        branch: dep.branch,
        ...(dep.status === 'failed' ? { failed: true } : {}),
        // Отпущенная группа идёт по ветке, где работа ещё пишется: сказать об
        // этом обязаны заданию, а не только карточке.
        ...(group.released && dep.status !== 'done' && dep.status !== 'failed'
          ? { unfinished: true }
          : {}),
        ...this.touchedBy(record, dep.index),
      }));
    // База — последний предшественник, у которого копия действительно была.
    const base = [...ordered]
      .reverse()
      .map((ref) => record.groups[ref])
      .find((dep) => dep && dep.chatId)?.branch;
    const question = group.hold;
    return {
      ...(base ? { base } : {}),
      ...(predecessors.length > 0 ? { predecessors } : {}),
      ...(group.holdAnswer && question
        ? { holdAnswer: { question, answer: group.holdAnswer } }
        : {}),
    };
  }

  /**
   * Настоящее имя ветки — в запись, ДО старта прогона группы.
   *
   * Запись заводится с ИМЕНЕМ ИЗ ПРЕДЛОЖЕНИЯ (`safeBranchName`), а git выдаёт
   * занятому имени суффикс, и до 18.09.2026 разница узнавалась только из ответа
   * всей порции. Между этими двумя моментами цепочка группы успевала кончиться
   * (у чужого CLI прогон падает на первом же вздохе), `onChainEnded` не находил
   * группу по ветке, и всё, что её ждало, стояло навсегда.
   */
  private claimBranch(
    portion: SplitPlanRecord,
    index: number,
    branch: string,
    path?: string,
  ): void {
    // Запись — свежая: пока шёл `worktree add`, человек мог поставить паузу.
    const record = this.deps.store.get(portion.parentChatId) ?? portion;
    const group = record.groups[index];
    if (!group || !branch) return;
    // Копия — туда же и тогда же (живой прогон 29.09): панель, перезапущенная
    // посреди подготовки, иначе теряла, где она лежит, и группу без чата нельзя
    // было ни завести в той же копии, ни убрать её.
    if (group.branch === branch && (!path || group.path === path)) return;
    group.branch = branch;
    if (path) group.path = path;
    this.deps.store.set(record);
    // Снимок порции тоже: по нему запуск договаривает остальное.
    const own = portion.groups[index];
    if (own && own !== group) {
      own.branch = branch;
      if (path) own.path = path;
    }
  }

  /** Группа всё ещё «стартует» — её прогон можно пускать (см. `SplitConveyorDeps.launch`). */
  private startable(parentChatId: string, index: number): boolean {
    const record = this.deps.store.get(parentChatId);
    return Boolean(record && !record.cancelledAt && record.groups[index]?.status === 'started');
  }

  /**
   * Что предшественник уже задел — из сверки веток (Т6).
   *
   * Порядок тут правильный сам собой: сверка зовётся по концу цепочки ДО
   * запуска ждавших, — но считается она асинхронно и может не успеть или
   * отказать вовсе. Поэтому отсутствие счёта — законное состояние: заметка
   * тогда просто не называет файлов, а не срывает запуск группы.
   */
  private touchedBy(
    record: SplitPlanRecord,
    index: number,
  ): { files?: string[]; filesTotal?: number } {
    const counted = record.overlap?.counted.find((item) => item.index === index);
    if (!counted) return {};
    return {
      ...(counted.names && counted.names.length > 0 ? { files: counted.names } : {}),
      filesTotal: counted.files,
    };
  }

  /**
   * `from` — из каких статусов вызывающий заводит группы. Сверяется по ЖИВОЙ
   * записи: порции одного насоса идут друг за другом, и пока предыдущая
   * заводит копию, человек мог поставить следующую группу на паузу или убрать
   * её — такую группу запуск пропускает, а не переписывает в «стартует».
   */
  private async runPortion(
    record: SplitPlanRecord,
    groups: number[],
    context: SplitGroupContext | undefined,
    from: readonly SplitPlanGroupRecord['status'][],
  ): Promise<TaskSplitResult> {
    // Статус «стартует» ставится ДО запуска: копии заводятся секунды, и второй
    // вызов за это время (ещё один конец цепочки) не должен завести те же группы.
    const at = this.now().toISOString();
    const live = this.deps.store.get(record.parentChatId) ?? record;
    const own = groups.filter((index) => {
      const group = live.groups[index];
      return Boolean(group && from.includes(group.status));
    });
    if (own.length === 0) return { chats: [], failures: [] };
    for (const index of own) {
      const group = live.groups[index] as SplitPlanGroupRecord;
      group.status = 'started';
      group.startedAt = at;
      delete group.pausedAt;
      // «Завести заново» оборванную группу: метка обрыва осталась бы на идущей
      // группе, и хаб звал бы «Продолжить», которое ничего не делает (ревью 30.09).
      delete group.waitingFor;
      delete group.interruptedAt;
      delete group.interruptResumes;
      if (context?.base) group.base = context.base;
    }
    this.deps.store.set(live);
    // Вызывающий дальше считает места по своему снимку — он обязан видеть старт.
    if (live !== record) Object.assign(record, live);

    const keys = own.map((index) => `${record.parentChatId}:${index}`);
    for (const key of keys) this.inFlight.set(key, (this.inFlight.get(key) ?? 0) + 1);
    try {
      let result: TaskSplitResult;
      try {
        result = await this.deps.launch(
          record,
          own,
          context,
          (index, branch, path) => this.claimBranch(record, index, branch, path),
          (index) => this.startable(record.parentChatId, index),
        );
      } catch (error) {
        const fresh = this.deps.store.get(record.parentChatId) ?? record;
        for (const index of own) {
          const group = fresh.groups[index];
          // Статус, который за время подготовки решил человек (пауза, «Убрать»)
          // или отмена плана, сбой запуска не перетирает.
          if (!group || fresh.cancelledAt || group.status !== 'started') continue;
          group.status = 'failed';
          group.error = error instanceof Error ? error.message : String(error);
        }
        this.deps.store.set(fresh);
        throw error;
      }
      // Запуск шёл минутами (копии, `npm ci`), и запись за это время меняли
      // другие: пауза, отмена, обрыв при перезапуске. Итог ложится на СВЕЖУЮ
      // запись — старый снимок молча вернул бы группе на паузе «стартует»
      // (живой прогон 29.09).
      const fresh = this.deps.store.get(record.parentChatId) ?? record;
      absorb(fresh, result, at);
      this.deps.store.set(fresh);
      if (fresh !== record) Object.assign(record, fresh);
      return result;
    } finally {
      for (const key of keys) {
        const left = (this.inFlight.get(key) ?? 1) - 1;
        if (left > 0) this.inFlight.set(key, left);
        else this.inFlight.delete(key);
      }
    }
  }

  /**
   * Продолжить ДОСТАВЛЕННУЮ группу словом панели (WP1j): в её MR после
   * «готово» пришли ветки ревьюера или упал конвейер (`mr-watch.ts`). Только
   * `done` с доставкой и живой копией: убранную копию продолжать негде, а
   * группу, которая снова работает или ждёт человека, наблюдатель не трогает.
   * Старт прогона сам переведёт группу в «работает» (`onChainResumed`).
   * Слово идёт с веткой и задачами группы первой строкой — как напоминания.
   *
   * Продолжение — тоже работа группы и занимает место под потолком (журнал 81,
   * WP9e): потолок полон или лимит подписки исчерпан — слово ждёт в записи
   * (`parked`) и уходит первым, как только место освободится.
   */
  resumeDelivered(
    parentChatId: string,
    index: number,
    prompt: string,
    recheck = false,
  ): 'sent' | 'queued' | 'refused' {
    const record = this.deps.store.get(parentChatId);
    const group = record?.groups[index];
    if (
      !record ||
      record.cancelledAt ||
      !group ||
      group.status !== 'done' ||
      !group.deliver ||
      group.cleaned
    ) {
      return 'refused';
    }
    if (!this.deps.resume || !group.chatId || !group.path) return 'refused';
    const parked = group.parked;
    if (parked || this.admission(record).kind !== 'ok') {
      // Два слова наблюдателя подряд — одно продолжение: оба про тот же MR.
      group.parked = parked
        ? { prompt: `${parked.prompt}\n\n${prompt}`, at: parked.at }
        : { prompt: this.withIdentity(record, group, prompt), at: this.now().toISOString() };
      if (recheck || parked?.recheck) group.parked.recheck = true;
      this.deps.store.set(record);
      if (this.admission(record).kind !== 'ok') return 'queued';
      // Итог — настоящий (m12): продолжение могли и не принять, и тогда
      // наблюдатель MR должен знать, что слово не дошло.
      return this.drainParked(parentChatId).get(index) ?? 'queued';
    }
    return this.send(parentChatId, group, this.withIdentity(record, group, prompt), recheck);
  }

  /**
   * Слово сессии группы. Несёт перепроверку — отметка «отдано» ставится ДО
   * отдачи: старт хода (`onChainResumed`) приходит изнутри `resume` и должен её
   * застать. Не приняли — снимается вместе с самой перепроверкой (ревью R2).
   */
  private send(
    parentChatId: string,
    group: SplitPlanGroupRecord,
    prompt: string,
    recheck: boolean,
  ): 'sent' | 'queued' | 'refused' {
    if (!this.deps.resume || !group.chatId || !group.path) return 'refused';
    if (recheck) {
      const record = this.deps.store.get(parentChatId);
      const own = record?.groups[group.index];
      if (record && own) {
        own.recheckSentAt = this.now().toISOString();
        this.deps.store.set(record);
      }
    }
    const current = this.deps.store.get(parentChatId);
    const target = current?.groups[group.index] ?? group;
    const outcome =
      recheck && this.deps.recheck && current
        ? this.deps.recheck(current, target, prompt)
        : this.deps.resume(target, prompt);
    if (recheck && outcome === 'refused') {
      const record = this.deps.store.get(parentChatId);
      const own = record?.groups[group.index];
      if (record && own) {
        dropRecheck(own);
        this.deps.store.set(record);
      }
    }
    return outcome;
  }

  /**
   * «Перепроверить MR» (владелец 05.10): отметка «перепроверяется» и слово
   * доставленной группе (`split-recheck.ts` собирает его по MR). Слово ждёт
   * места, как у наблюдателя MR (`queued`); не дошло — отметка откатывается.
   */
  recheckDelivered(parentChatId: string, index: number, prompt: string): SplitGroupRechecked {
    const record = this.deps.store.get(parentChatId);
    const group = record?.groups[index];
    if (!record || !group) {
      throw coded(
        new Error('Перепроверять нечего: у группы нет доставленного MR или её копия убрана'),
        'split-recheck-nothing',
      );
    }
    // Перепроверка уже ждёт (вторая вкладка, телефон) — второго слова нет (ревью G1).
    if (group.recheckRequestedAt && (group.parked?.recheck || group.recheckSentAt)) {
      return {
        index,
        outcome: group.recheckRunning ? 'sent' : 'queued',
        requestedAt: group.recheckRequestedAt,
      };
    }
    // Прежняя зелёная отметка живёт до старта хода перепроверки: не дошло слово —
    // она на месте.
    const requestedAt = this.now().toISOString();
    group.recheckRequestedAt = requestedAt;
    this.deps.store.set(record);
    const outcome = this.resumeDelivered(parentChatId, index, prompt, true);
    if (outcome !== 'refused') return { index, outcome, requestedAt };
    const fresh = this.deps.store.get(parentChatId);
    const same = fresh?.groups[index];
    if (fresh && same) {
      dropRecheck(same);
      this.deps.store.set(fresh);
    }
    throw coded(
      new Error('Продолжить группу нечем: у неё нет разговора или копии'),
      'split-resume-refused',
    );
  }

  /**
   * «Продолжить» группу, остановившуюся недоделанной (владелец 05.10): сдалась
   * на сбое — повторы кончились, доступ CLI пропал, доставка не сошлась — или
   * кончила ход без вердикта ревью. Раньше у сдавшейся группы с чатом не было
   * ни одной кнопки, и продолжить её можно было только словом в её чат.
   *
   * Сбой место под потолком отдал — продолжение занимает его снова (отказ с
   * числами, с согласием — сверх); ждущая держит своё, ей — только лимит.
   * Счёт повторов и напоминаний о доставке начинается заново: человек сказал
   * пробовать ещё.
   */
  continueGroup(parentChatId: string, index: number, force = false): 'sent' | 'queued' {
    const record = this.deps.store.get(parentChatId);
    const group = record?.groups[index];
    if (!record || !group || !continuable(record, group)) {
      throw coded(
        new Error('Продолжать нечего: группа не остановилась недоделанной'),
        'split-continue-nothing',
      );
    }
    // Задание уже ждёт в очереди сессии (вторая вкладка, повторный клик) —
    // второго нет: сессия выполнила бы оба (ревью G2).
    if (group.continueQueuedAt) return 'queued';
    if (!force) {
      if (group.status === 'failed') this.admit(record);
      else this.admitLimit(record);
    }
    const prompt = continuePrompt({
      branch: group.branch,
      deliver: group.deliver === true,
      ...(group.error ? { error: group.error } : {}),
    });
    const outcome = this.deps.resume
      ? this.deps.resume(group, this.withIdentity(record, group, prompt))
      : 'refused';
    if (outcome === 'refused') {
      throw coded(
        new Error('Продолжить группу нечем: у неё нет разговора или копии'),
        'split-resume-refused',
      );
    }
    const fresh = this.deps.store.get(parentChatId);
    const same = fresh?.groups[index];
    if (fresh && same) {
      delete same.retries;
      delete same.deliveryNudges;
      delete same.deliveryNudgeKey;
      delete same.deliveryNudgeStage;
      delete same.deliveryHistory;
      delete same.deliveryEscalatedAt;
      delete same.deliveryEscalatedAfter;
      // Слово человека — новый счёт и повторов панели (`DELIVERY_RETRY_MAX`).
      delete same.deliveryRetry;
      if (outcome === 'queued') same.continueQueuedAt = this.now().toISOString();
      this.deps.store.set(fresh);
    }
    return outcome;
  }

  /**
   * «Отменить план» (владелец, 25.09.2026): застрявший или ненужный план новым
   * «Разделить» молча не перекрывается — человек отменяет его явно. Незакрытые
   * группы закрываются сбоем «план отменён», запись получает отметку; чаты,
   * копии и ветки остаются. Возвращает разговоры, чьи прогоны маршрут
   * остановит сам: идущий разбор и группы, у которых есть чат.
   */
  cancel(parentChatId: string): { chatIds: string[]; cancelled: number; paths: string[] } {
    const record = this.deps.store.get(parentChatId);
    // Записи нет вовсе — не «уже закончилось» (D7): такого плана не было, и
    // отказ должен это сказать, а не выдумать закончившийся план.
    if (!record) {
      throw coded(new Error('Разделения с этим разговором нет'), 'split-plan-cancel-unknown');
    }
    if (record.cancelledAt || !splitPlanRunning(record.groups)) {
      throw coded(
        new Error('Отменять нечего: разделение этого разговора уже закончилось'),
        'split-plan-cancel-nothing',
      );
    }
    const chatIds: string[] = [];
    // Разбор ещё идёт — его прогон гасится тоже: итог разбора завёл бы группы.
    if (!record.triage && record.triageChatId) chatIds.push(record.triageChatId);
    let cancelled = 0;
    for (const group of record.groups) {
      if (group.status === 'done' || group.status === 'failed') continue;
      if (group.chatId) chatIds.push(group.chatId);
      this.apply(group, { status: 'failed', error: serverText('split-group-plan-cancelled') });
      // Отложенное слово наблюдателя и пауза — про план, которого больше нет.
      delete group.parked;
      delete group.pausedAt;
      cancelled += 1;
    }
    record.cancelledAt = this.now().toISOString();
    this.deps.store.set(record);
    // Копии групп: простаивающие в них процессы CLI маршрут закроет (F4c).
    // Группа без копии работает в самом проекте — там же и родитель, и его
    // процессы уборка плана не трогает.
    const norm = (value: string): string =>
      value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const within = (path: string, dir: string): boolean =>
      norm(path) === norm(dir) || norm(path).startsWith(`${norm(dir)}/`);
    const paths = record.groups.flatMap((group) =>
      group.path &&
      !group.cleaned &&
      !within(group.path, record.projectPath) &&
      !within(group.path, copyRootOf(record))
        ? [group.path]
        : [],
    );
    return { chatIds, cancelled, paths };
  }

  /**
   * Пауза группы человеком (журнал 81a). Ждавшие её остаются ждать: пауза не
   * «готово». Место под потолком группа ДЕРЖИТ (живой прогон 29.09: владелец
   * остановил все группы, а освободившиеся места тут же завели две из очереди) —
   * очередь двигает конец цепочки, а не пауза. Группа из очереди (`pending`)
   * места не держала и не держит: она просто пропускается, пока на паузе.
   * Возвращает чаты группы — их прогон маршрут остановит сам.
   */
  pause(parentChatId: string, index: number): { chatIds: string[] } {
    const record = this.deps.store.get(parentChatId);
    const group = record?.groups[index];
    if (!record || !group || !PAUSABLE_BY_HUB.includes(group.status)) {
      throw coded(
        new Error('Группа сейчас не работает — ставить на паузу нечего'),
        'split-pause-not-running',
      );
    }
    this.hold(record, group);
    return { chatIds: group.chatId ? [group.chatId] : [] };
  }

  /** «Стоп» человека в чате группы — та же пауза (журнал 89c). */
  pauseByLink(link: ChatLink): boolean {
    const record = this.deps.store.get(link.parentChatId);
    const group = record && this.groupOf(record, link, PAUSABLE);
    if (!record || !group) return false;
    this.hold(record, group);
    return true;
  }

  /** Группа на паузе — повтор упавшего хода её не продолжает. */
  isPaused(link: ChatLink): boolean {
    const record = this.deps.store.get(link.parentChatId);
    return Boolean(record && this.groupOf(record, link, ['paused']));
  }

  /** Связь ведёт к живой группе конвейера — её лимит помнит запись, а не таймер. */
  tracksGroup(link: ChatLink): boolean {
    const record = this.deps.store.get(link.parentChatId);
    return Boolean(record && this.groupOf(record, link, PAUSABLE));
  }

  /**
   * «Продолжить» группу с паузы. Место она держала сама (`occupied`), поэтому
   * потолок её не останавливает; лимит подписки — отказ со сроком, а с
   * согласием человека (`force`) — всё равно.
   *
   * Три вида паузы — три продолжения: из очереди — назад в очередь (`queued`,
   * стартует, как дойдёт черёд); во время подготовки копии — старт прогона в
   * этой копии; с разговором — той же сессией.
   */
  resumePaused(parentChatId: string, index: number, force = false): 'sent' | 'queued' {
    const record = this.deps.store.get(parentChatId);
    const group = record?.groups[index];
    if (!record || !group || group.status !== 'paused') {
      throw coded(new Error('Группа не на паузе — продолжать нечего'), 'split-resume-not-paused');
    }
    if (!seated(group)) {
      group.status = 'pending';
      delete group.pausedAt;
      this.deps.store.set(record);
      void this.launchNext(record).catch((error) => {
        this.deps.log('split conveyor: launch after unpause failed', error);
      });
      return 'queued';
    }
    if (!force) this.admitLimit(record);
    if (!group.chatId && this.inFlight.has(`${parentChatId}:${index}`)) {
      // Пауза пришла, пока копия ещё заводится: запуск жив и сам пустит прогон,
      // если группа снова «стартует». Второй запуск завёл бы вторую копию.
      group.status = 'started';
      delete group.pausedAt;
      this.deps.store.set(record);
      return 'sent';
    }
    if (!group.chatId && group.path) {
      void this.startInCopy(record, group);
      return 'sent';
    }
    if (!group.chatId) {
      // Место есть, а копии не записано (пауза до `worktree add`, потом
      // перезапуск панели): продолжать нечего — группа заводится заново.
      void this.runPortion(record, [index], this.contextFor(record, index), ['paused']).catch(
        (error) => {
          this.deps.log('split conveyor: start after unpause failed', error);
        },
      );
      return 'sent';
    }
    const prompt = this.withIdentity(
      record,
      group,
      pauseResumePrompt(group.branch, group.pausedTasks, group),
    );
    if (group.pausedTasks) {
      delete group.pausedTasks;
      this.deps.store.set(record);
    }
    const outcome =
      this.deps.resume && group.chatId && group.path ? this.deps.resume(group, prompt) : 'refused';
    if (outcome === 'refused') {
      throw coded(
        new Error('Продолжить группу нечем: у неё нет разговора или копии'),
        'split-resume-refused',
      );
    }
    return outcome;
  }

  /**
   * «Запустить сейчас» группу из очереди — мимо порядка разбора. Потолок и
   * лимит те же, что у «Продолжить»: отказ, а с согласием — сверх.
   */
  async startNow(parentChatId: string, index: number, force = false): Promise<TaskSplitResult> {
    const record = this.deps.store.get(parentChatId);
    const group = record?.groups[index];
    if (!record || !group || group.status !== 'pending') {
      throw coded(new Error('Группа не в очереди — запускать нечего'), 'split-start-not-queued');
    }
    // Посреди разбора группу заводит его блок: запуск сейчас дал бы ей вторую копию (ревью PR #1).
    if (triagePending(record)) {
      throw coded(
        new Error(
          'Разбор задач ещё идёт — порядок групп решит он; запуск станет доступен после него',
        ),
        'split-start-triage',
      );
    }
    if (!force) this.admit(record);
    return this.runPortion(
      record,
      [index],
      group.holdAnswer ? this.contextFor(record, index) : undefined,
      ['pending'],
    );
  }

  /**
   * Группа, оборванная до своего чата (живой прогон 29.09: перезапуск панели
   * посреди `npm ci`), — «Завести заново». Продолжать ей нечего: сессии нет.
   * Копия известна — прогон стартует в ней (подготовка повторяется: прежняя
   * могла оборваться); неизвестна (запись старше 29.09) — заводится новая.
   * Место группа держала сама, поэтому потолок её не держит; лимит — как у
   * «Продолжить». Ответ — сразу, как у «Продолжить»: подготовка копии идёт
   * минутами, и кнопка не должна висеть всё это время.
   */
  async restartGroup(parentChatId: string, index: number, force = false): Promise<void> {
    const { record, group } = this.cutGroup(parentChatId, index);
    if (!force) this.admitLimit(record);
    if (this.inFlight.has(`${parentChatId}:${index}`)) {
      // Прежний запуск ещё заводит копию (обрыв записан под ним): он жив и сам
      // пустит прогон, если группа снова «стартует». Второй запуск в той же
      // копии дал бы два прогона группы (ревью 30.09).
      group.status = 'started';
      delete group.waitingFor;
      delete group.interruptedAt;
      delete group.interruptResumes;
      this.deps.store.set(record);
      return;
    }
    if (group.path) {
      void this.startInCopy(record, group);
      return;
    }
    void this.runPortion(record, [index], this.contextFor(record, index), ['awaiting']).catch(
      (error) => {
        this.deps.log('split conveyor: restart failed', error);
      },
    );
  }

  /**
   * «Убрать» группу: оборванную до своего чата или на паузе — закрыть её сбоем
   * с причиной. Пауза держит место под потолком, и без «Убрать» ненужную
   * группу на паузе было не отпустить, кроме как отменой всего плана. Место
   * уходит очереди, ждавшие её — дальше (как после любого сбоя); копия, если
   * она есть, убирается обычной кнопкой уборки закрытой группы.
   */
  /**
   * Человек отметил группу готовой (`split-acceptance.ts`): ждавшие её больше
   * не ждут, а место, которое она держала, свободно — очередь двигается так же,
   * как после «готово» конвейера.
   */
  afterMarkedDone(record: SplitPlanRecord): void {
    void this.launchNext(record).catch((error) => {
      this.deps.log('split conveyor: launch after manual done failed', error);
    });
  }

  dropGroup(parentChatId: string, index: number): void {
    const record = this.deps.store.get(parentChatId);
    const group = record?.groups[index];
    const droppable =
      record &&
      !record.cancelledAt &&
      group &&
      (group.status === 'paused' ||
        (group.status === 'awaiting' && group.waitingFor === 'interrupted' && !group.chatId));
    if (!record || !group || !droppable) {
      throw coded(
        new Error('Убирать нечего: группа не на паузе и не оборвана до своего чата'),
        'split-drop-nothing',
      );
    }
    this.apply(group, { status: 'failed', error: serverText('split-group-dropped') });
    group.doneAt = this.now().toISOString();
    // «Убрать» — без возврата: «Продолжить» такой группе не положено (ревью R3).
    group.droppedAt = group.doneAt;
    delete group.interruptedAt;
    delete group.interruptResumes;
    delete group.pausedAt;
    this.deps.store.set(record);
    void this.launchNext(record).catch((error) => {
      this.deps.log('split conveyor: launch after drop failed', error);
    });
  }

  /** Оборванная группа без чата — иначе отказ: у группы с чатом есть «Продолжить». */
  private cutGroup(
    parentChatId: string,
    index: number,
  ): { record: SplitPlanRecord; group: SplitPlanGroupRecord } {
    const record = this.deps.store.get(parentChatId);
    const group = record?.groups[index];
    if (
      !record ||
      record.cancelledAt ||
      !group ||
      group.status !== 'awaiting' ||
      group.waitingFor !== 'interrupted' ||
      group.chatId
    ) {
      throw coded(
        new Error('Группа не оборвана до своего чата — заводить заново нечего'),
        'split-restart-not-cut',
      );
    }
    return { record, group };
  }

  /**
   * Прогон группы в уже заведённой копии — без новой копии и новой ветки.
   * Статус «стартует» `runPortion` ставит синхронно, до первого ожидания.
   */
  private async startInCopy(record: SplitPlanRecord, group: SplitPlanGroupRecord): Promise<void> {
    const path = group.path as string;
    try {
      await this.runPortion(
        record,
        [group.index],
        { ...this.contextFor(record, group.index), copy: { path, branch: group.branch } },
        ['paused', 'awaiting'],
      );
    } catch (error) {
      this.deps.log('split conveyor: start in copy failed', error);
    }
  }

  /**
   * После перезапуска панели: ожидание сброса лимита лежит в записи, а таймер
   * умер с прежним процессом (журнал 89a — группы так и не продолжились).
   * Ставим его заново; срок уже прошёл — будим сразу. Отложенные продолжения,
   * которым место уже есть, уходят тут же.
   */
  recoverLimitWaits(): void {
    this.armLimitWake(true);
    for (const record of Object.values(this.deps.store.all())) {
      if (record.groups.some((group) => group.parked)) this.drainParked(record.parentChatId);
      // Очередь, которую держал срок из предупреждения (до 29.09 он держал),
      // не будит ни таймер, ни событие: после перезапуска запускаем её сами.
      // Места и порядок проверяет `launchNext`.
      if (
        !record.cancelledAt &&
        !this.limitedUntil(providerOf(record)) &&
        record.groups.some((group) => group.status === 'pending')
      ) {
        void this.launchNext(record).catch((error) => {
          this.deps.log('split conveyor: launch after restart failed', error);
        });
      }
    }
  }

  /** Пауза: запись и место в очереди (без остановки прогона — это дело маршрута). */
  private hold(record: SplitPlanRecord, group: SplitPlanGroupRecord): void {
    // Пауза зовётся ДО остановки процесса (кнопка хаба и «Стоп» в чате), поэтому
    // фон ещё жив и его можно назвать.
    const killed = group.chatId ? (this.deps.backgroundTasks?.(group.chatId) ?? []) : [];
    if (killed.length > 0) group.pausedTasks = killed.slice(0, MAX_PAUSED_TASKS);
    else delete group.pausedTasks;
    group.status = 'paused';
    group.pausedAt = this.now().toISOString();
    delete group.waitingFor;
    delete group.limitUntil;
    if (group.parked?.recheck) dropRecheck(group);
    delete group.parked;
    delete group.interruptedAt;
    this.deps.store.set(record);
  }

  /** Есть ли место для работы сейчас: лимит подписки, потом потолок. */
  private admission(
    record: SplitPlanRecord,
  ):
    | { kind: 'ok' }
    | { kind: 'ceiling'; running: number; paused: number; limit: number }
    | { kind: 'limit'; until: string } {
    const until = this.limitedUntil(providerOf(record));
    if (until) return { kind: 'limit', until };
    const limit = this.deps.parallel?.(record);
    if (!limit || limit < 1) return { kind: 'ok' };
    const taken = this.occupied(record);
    if (taken < limit) return { kind: 'ok' };
    const paused = record.groups.filter(
      (group) => group.status === 'paused' && seated(group),
    ).length;
    return { kind: 'ceiling', running: taken - paused, paused, limit };
  }

  /** Только лимит подписки: своё место группа уже держит. */
  private admitLimit(record: SplitPlanRecord): void {
    if (this.admission(record).kind === 'limit') this.admit(record);
  }

  /** Отказ человеку, когда места нет, — с числами, чтобы он решил про «сверх». */
  private admit(record: SplitPlanRecord): void {
    const verdict = this.admission(record);
    if (verdict.kind === 'ceiling' && verdict.paused > 0) {
      // Место держат паузы (живой прогон 29.09): «работает 0 из 1» без них
      // читалось как ошибка панели — человеку надо видеть, что их можно убрать.
      const params = {
        running: String(verdict.running),
        paused: String(verdict.paused),
        limit: String(verdict.limit),
      };
      throw coded(
        new Error(
          `Все места заняты: работает ${params.running}, на паузе ${params.paused} из ${params.limit}`,
        ),
        'split-group-no-slot-paused',
        params,
      );
    }
    if (verdict.kind === 'ceiling') {
      const params = { running: String(verdict.running), limit: String(verdict.limit) };
      throw coded(
        new Error(`Все места заняты: работает ${params.running} из ${params.limit}`),
        'split-group-no-slot',
        params,
      );
    }
    if (verdict.kind === 'limit') {
      // Клиенту — сам момент: часы он соберёт по поясу смотрящего
      // (`CLOCK_PARAMS`); часы панели — только в запасной русской строке.
      throw coded(
        new Error(`Лимит подписки исчерпан до ${clockTime(verdict.until)}`),
        'split-limit-active',
        { until: verdict.until },
      );
    }
  }

  /**
   * Самый поздний известный срок сброса лимита (мс) у каждого провайдера,
   * прошедший тоже. Лимит подписки Claude очередь чужого CLI не держит (m11).
   */
  private limitHorizons(): Map<string, number> {
    const horizons = new Map<string, number>();
    for (const record of Object.values(this.deps.store.all())) {
      const provider = providerOf(record);
      // Срок из предупреждения «на исходе» очередь не держит (живой прогон 29.09):
      // недельное предупреждение со сроком через двое суток, записанное старым
      // разделением, стопорило все новые. Держит только настоящий отказ — он
      // придёт сам, если лимит и правда кончится, и очередь дождётся сброса.
      const dates = record.limitWarning ? [] : [record.limitUntil];
      for (const group of record.groups) {
        if (group.status === 'awaiting' && group.waitingFor === 'limit') {
          dates.push(group.limitUntil ?? new Date(0).toISOString());
        }
      }
      for (const date of dates) {
        const at = date ? Date.parse(date) : Number.NaN;
        const known = horizons.get(provider);
        if (Number.isFinite(at) && (known === undefined || at > known)) horizons.set(provider, at);
      }
    }
    return horizons;
  }

  /** Лимит подписки провайдера ещё действует: до какого момента (ISO). Он на весь его аккаунт. */
  private limitedUntil(provider: string): string | undefined {
    const horizon = this.limitHorizons().get(provider);
    return horizon !== undefined && horizon > this.now().getTime()
      ? new Date(horizon).toISOString()
      : undefined;
  }

  /** Ход группы упёрся в лимит: срок — в запись, таймер, заметка родителю. */
  private noteLimit(record: SplitPlanRecord, until: string, warning = false): void {
    const at = Date.parse(until);
    const now = this.now().getTime();
    if (!Number.isFinite(at) || (warning && at <= now)) return;
    const known = record.limitUntil ? Date.parse(record.limitUntil) : 0;
    // Предупреждение не подменяет идущий отказ: очередь держит отказ, а срок
    // «на исходе» её не держит — подмена отпустила бы её в стену (ревью 30.09).
    if (warning && !record.limitWarning && known > now) {
      this.armLimitWake();
      return;
    }
    // Отказ сильнее предупреждения при любом сроке: прежний срок «на исходе»
    // (недельный — через двое суток) иначе становился сроком настоящего отказа,
    // и очередь ждала двое суток вместо трёх часов (ревью 30.09).
    if (at > known || (!warning && record.limitWarning)) {
      record.limitUntil = new Date(at).toISOString();
      // Отказ сильнее предупреждения: срок, поставленный отказом, — уже не
      // «на исходе», а «исчерпан».
      if (warning) record.limitWarning = true;
      else delete record.limitWarning;
      this.deps.store.set(record);
      // Одна заметка на срок: остальные группы упрутся в тот же лимит.
      // Строка — по часам панели (запасная), код — с моментом: клиент
      // покажет часы в поясе того, кто читает ленту.
      const textCode = warning ? 'split-limit-warning-notice' : 'split-limit-wait-notice';
      this.deps.notify?.(record.parentChatId, {
        kind: 'notice',
        code: 'groupsLimited',
        text: serverText(textCode, { until: clockTime(record.limitUntil) }),
        textCode,
        textParams: { until: record.limitUntil },
      });
    }
    this.armLimitWake();
  }

  private schedule(run: () => void, ms: number): void {
    const delay = Math.min(Math.max(0, ms), MAX_TIMER_MS);
    if (this.deps.schedule) this.deps.schedule(run, delay);
    else setTimeout(run, delay);
  }

  /**
   * Один таймер на все записи. У каждого провайдера свой срок (m11): таймер
   * встаёт к ближайшему, а проснувшись, продолжает тех, чей лимит сброшен, и
   * встаёт к следующему. Прошедший срок будит сразу только после перезапуска
   * (`overdue`): в работе прошедший срок — это группы, которые уже будятся по
   * очереди, и второй подъём продолжил бы их дважды.
   */
  private armLimitWake(overdue = false): void {
    const now = this.now().getTime();
    const horizons = [...this.limitHorizons().values()].filter((at) => overdue || at > now);
    if (horizons.length === 0) return;
    const horizon = Math.min(...horizons);
    if (this.limitWakeAt !== undefined && this.limitWakeAt <= horizon) return;
    this.limitWakeAt = horizon;
    const token = ++this.limitWakeToken;
    this.schedule(() => {
      if (token === this.limitWakeToken) this.wakeFromLimit();
    }, horizon - this.now().getTime());
  }

  /**
   * Срок сброса настал: ждавшие группы продолжаются — первая сразу, остальные
   * с паузой, — и очередь снова идёт. Лимит сдвинулся — таймер заново.
   */
  private wakeFromLimit(): void {
    this.limitWakeAt = undefined;
    const waiting: { parentChatId: string; index: number }[] = [];
    // Проснулись к сроку одного провайдера: у другого лимит может ещё идти —
    // его записи ждут своего срока, таймер встанет к нему ниже.
    const records = Object.values(this.deps.store.all()).filter(
      (record) => !this.limitedUntil(providerOf(record)),
    );
    for (const record of records) {
      for (const group of record.groups) {
        if (group.status === 'awaiting' && group.waitingFor === 'limit') {
          waiting.push({ parentChatId: record.parentChatId, index: group.index });
        }
      }
      if (!record.limitUntil) continue;
      delete record.limitUntil;
      delete record.limitWarning;
      this.deps.store.set(record);
    }
    waiting.forEach((item, order) => {
      const run = () => this.resumeLimited(item.parentChatId, item.index);
      if (order === 0) run();
      else this.schedule(run, order * LIMIT_RESUME_STAGGER_MS);
    });
    for (const record of records) {
      const idle = record.groups.some(
        (group) => group.status === 'pending' || group.status === 'waiting' || group.parked,
      );
      if (!idle) continue;
      void this.launchNext(record).catch((error) => {
        this.deps.log('split conveyor: launch after limit reset failed', error);
      });
    }
    // Лимит другого провайдера ещё идёт — таймер к его сроку.
    this.armLimitWake();
  }

  /** Продолжить группу, ждавшую сброса; продолжать нечем — она «прервана». */
  private resumeLimited(parentChatId: string, index: number): void {
    const record = this.deps.store.get(parentChatId);
    const group = record?.groups[index];
    if (!record || !group || group.status !== 'awaiting' || group.waitingFor !== 'limit') return;
    // Пока ждали своей очереди, лимит снова закрылся — ждём следующего сброса.
    if (this.limitedUntil(providerOf(record))) {
      this.armLimitWake();
      return;
    }
    const prompt = this.withIdentity(record, group, limitResumePrompt(group.branch, group));
    const outcome =
      this.deps.resume && group.chatId && group.path ? this.deps.resume(group, prompt) : 'refused';
    if (outcome !== 'refused') return;
    this.deps.log(`split conveyor: resume after limit refused (${parentChatId}#${index})`);
    const fresh = this.deps.store.get(parentChatId);
    const same = fresh?.groups[index];
    if (fresh && same?.status === 'awaiting' && same.waitingFor === 'limit') {
      this.interrupt(fresh, same);
    }
  }

  /**
   * Отложенные продолжения доставленных групп — пока есть место. Группа,
   * которая уже работает, получает слово без проверки: место она и так держит.
   */
  private drainParked(parentChatId: string): Map<number, 'sent' | 'queued' | 'refused'> {
    // Чем кончилось слово каждой отпущенной группы (m12); оставшиеся ждать не названы.
    const outcomes = new Map<number, 'sent' | 'queued' | 'refused'>();
    const record = this.deps.store.get(parentChatId);
    if (!record) return outcomes;
    for (const { index } of this.ordered(record)) {
      const current = this.deps.store.get(parentChatId);
      const group = current?.groups[index];
      if (!current || !group?.parked) continue;
      const busy = group.status === 'started' || group.status === 'background';
      if (!busy && this.admission(current).kind !== 'ok') return outcomes;
      const { prompt, recheck } = group.parked;
      delete group.parked;
      this.deps.store.set(current);
      const outcome = this.send(parentChatId, group, prompt, Boolean(recheck));
      outcomes.set(index, outcome);
      if (outcome === 'refused') {
        this.deps.log(`split conveyor: parked resume refused (${parentChatId}#${index})`);
      }
    }
    return outcomes;
  }
}

/** Перепроверка снята: ход кончился, слово не дошло или потерялось. */
function dropRecheck(group: SplitPlanGroupRecord): void {
  delete group.recheckRequestedAt;
  delete group.recheckSentAt;
  delete group.recheckRunning;
}

/** Отказ оживить отменённый план — перезапуском или «Продолжить» (m1, D6). */
export function cancelledPlan(): Error {
  return coded(
    new Error('План отменён: его группы закрыты — начните новое разделение'),
    'split-plan-cancelled',
  );
}

/** Сколько следов звеньев держит группа: круги работы повторяются, хвоста хватает. */
const STAGE_TRACE_MAX = 30;

/**
 * След звена в записи группы (аудит 25.09, L110). Новое звено — новая строка;
 * тот же чат ещё раз (ответ человека, продолжение) строку не множит. Ревью,
 * кончившее цепочку, дописывает число замечаний своего вердикта.
 */
export function traceStage(
  group: SplitPlanGroupRecord,
  link: ChatLink,
  now: Date,
  reviewFindings?: number,
): void {
  const stage = link.stage ?? 'work';
  const trace = group.stageTrace ?? [];
  const last = trace[trace.length - 1];
  const entry = last?.stage === stage ? last : { stage, at: now.toISOString() };
  if (entry !== last) trace.push(entry);
  if (stage === 'review' && reviewFindings !== undefined) entry.findings = reviewFindings;
  group.stageTrace = trace.slice(-STAGE_TRACE_MAX);
}

/**
 * Чего не хватает до готовности по следам звеньев: ревью, начатое последним,
 * дошло до вердикта, а вердикт с замечаниями прошёл звено правок. Ревью не
 * было вовсе (работа шла на потолке) — следам проверять нечего.
 */
export function stageTraceGaps(trace: readonly SplitStageTraceEntry[] | undefined): string[] {
  if (!trace) return [];
  let review = -1;
  trace.forEach((entry, index) => {
    if (entry.stage === 'review') review = index;
  });
  if (review < 0) return [];
  const after = trace.slice(review + 1);
  // За ревью шло звено — вердикт был (правки или доставка заводятся по нему).
  if (after.length > 0) return [];
  const findings = trace[review]?.findings;
  if (findings === undefined) return [serverText('delivery-gap-review-unfinished')];
  if (findings > 0) return [serverText('delivery-gap-fix-missing', { count: findings })];
  return [];
}

type SplitStageTraceEntry = NonNullable<SplitPlanGroupRecord['stageTrace']>[number];
