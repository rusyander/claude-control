import {
  applySplitPlan,
  scanSplitPlanBlocks,
  triageStagePrompt,
  type PredecessorNote,
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
  type SplitPlanView,
} from '@agentdeck/contracts/chat-handoff';
import type {
  ChatLink,
  SplitPlanGroupRecord,
  SplitPlanRecord,
} from '../../lib/app-store/app-store.types.ts';
import type { ChatEvent } from './ChatRunner.ts';
import type { RunFinished } from './ChatRunRegistry.ts';
import type { SplitGroupContext } from './ChatSplit.ts';
import { coded } from '../../lib/server-text.ts';
import { normalizePath } from '../project-runner/targets.ts';
import { matchText, serverText } from '../../lib/server-texts.ts';
import {
  deliveryIncompleteText,
  deliveryMissingCodesOf,
  errorCodeOf,
} from './split-group-texts.ts';

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
}

export interface SplitConveyorDeps {
  store: SplitConveyorStore;
  /**
   * Проект трекера для тикетов групп по пути проекта: привязан и интеграция
   * подключена. Нет зависимости или ответа — завести тикет из хаба нельзя.
   */
  ticketTracker?: (projectPath: string) => string | undefined;
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
    claimBranch: (index: number, branch: string) => void,
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
   * Продолжить разговор группы словом панели — тем же каналом, что слово
   * родителя (Д7). Нужен оборванной группе (WP1c); не задан — она ждёт кнопки.
   */
  resume?: (group: SplitPlanGroupRecord, prompt: string) => 'sent' | 'queued' | 'refused';
  /**
   * Таймер ожидания сброса лимита (журнал 89). Сам срок лежит в записи, таймер
   * только будит; не задан — `setTimeout`.
   */
  schedule?: (run: () => void, ms: number) => unknown;
  /** Заметка в ленту родителя (лимит подписки); не задана — хаб покажет и так. */
  notify?: (parentChatId: string, event: ChatEvent) => void;
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
   * Сама копия не читается (status/rev-parse упали локально): ждать тут нечего,
   * сеть ни при чём — группа закрывается сбоем с причиной (m5).
   */
  failed?: string;
}

export interface SplitDeliveryDeps {
  facts: (
    group: SplitPlanGroupRecord,
    mrHint: string | undefined,
    projectPath: string,
  ) => Promise<DeliveryVerdict>;
  /**
   * Продолжить разговор группы сообщением панели — тем же путём, что слово
   * родителя (Д7): занятая группа получит его после своего хода.
   */
  nudge: (group: SplitPlanGroupRecord, prompt: string) => 'sent' | 'queued' | 'refused';
  schedule?: (run: () => void, ms: number) => unknown;
}

/** Сколько раз панель напоминает группе доделать доставку, прежде чем сдаться. */
export const MAX_DELIVERY_NUDGES = 2;
/** Пауза перед повторной сверкой: ссылка MR у форджа появляется не сразу после push. */
export const DELIVERY_SETTLE_MS = 20_000;
/** Паузы между проверками, когда удалённый не отвечает; дальше — `failed` с причиной. */
export const DELIVERY_RECHECK_MS: readonly number[] = [60_000, 300_000, 900_000];
/** Удалённый лежит дольше коротких попыток: проверка раз в столько… */
export const DELIVERY_BLOCKED_PROBE_MS = 15 * 60_000;
/** …столько раз (4 часа), дальше — `failed` с причиной. */
export const DELIVERY_BLOCKED_PROBES = 16;

/** Префиксы вида «XXX-9», которые ключом задачи трекера не бывают. */
const NOT_TRACKER = new Set(['UTF', 'ISO', 'SHA', 'RFC', 'CVE', 'TLS', 'HTTP', 'MD', 'ES', 'IEC']);

/** Ключи задач трекера (`PROJ-1064`) в тексте — по порядку, без повторов. */
export function trackerKeys(text: string): string[] {
  const keys: string[] = [];
  for (const match of text.matchAll(/\b([A-Z][A-Z0-9]{1,9})-([1-9]\d{0,6})\b/g)) {
    if (NOT_TRACKER.has(match[1] ?? '')) continue;
    if (!keys.includes(match[0])) keys.push(match[0]);
  }
  return keys;
}

/**
 * Первая строка каждого сообщения, которое панель сама шлёт в чат группы
 * (журнал 98): ветка и ключи задач. Сторож git пускает правку истории своей
 * ветки только по ключу задачи в словах пользователя текущего окна, а в
 * продолжении, заведённом панелью, ключа не было — агент упёрся в отказ и
 * встал с вопросом. Звено и продолжение без ветки к тому же не знают, где они.
 */
export function groupIdentityLine(branch: string, tickets: readonly string[]): string {
  const parts = [branch ? `Ветка группы: ${branch}.` : ''];
  if (tickets.length > 0) parts.push(`Задачи группы: ${tickets.join(', ')}.`);
  return parts.filter(Boolean).join(' ');
}

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

/** Напоминание группе: чего не хватает, и что делать, если доставка невозможна. */
export function deliveryNudgePrompt(branch: string, missing: readonly string[]): string {
  return [
    'Панель проверила доставку группы по git — она не доведена. Не хватает:',
    ...missing.map((line) => `- ${line}`),
    '',
    `Доведи по навыку доставки: закоммить работу, отправь ветку ${branch}, открой MR ` +
      '(или обнови существующий) и дай ссылку на него последней строкой. Если доставка ' +
      'невозможна (нет доступа, решение за человеком) — спроси человека вопросом, а не отчётом.',
  ].join('\n');
}

/**
 * Сколько раз подряд панель сама продолжает оборванную группу. Дальше — кнопка
 * человека: процесс, который умирает каждый ход, сам по себе не выздоровеет.
 */
export const MAX_INTERRUPT_RESUMES = 2;

/** Продолжение оборванной группы: сперва восстановить состояние по фактам, потом работать. */
export function interruptResumePrompt(branch: string): string {
  return [
    'Процесс этой группы оборвался посреди хода (перезапуск панели или смерть CLI): фоновые ' +
      'команды погибли, незаписанное в файлы пропало.',
    'Сначала восстанови состояние по фактам: git status, git log, что уже сделано — по своему ' +
      'транскрипту; оборванные проверки запусти заново.',
    `Потом продолжи с места остановки в ветке ${branch}. Если работа уже была закончена — ` +
      'повтори итог последнего хода (что сделано, ссылка на MR) и остановись.',
  ].join('\n');
}

/**
 * Пауза между продолжениями групп после сброса лимита (журнал 89): разом они
 * снова упёрлись бы в только что открывшийся лимит.
 */
export const LIMIT_RESUME_STAGGER_MS = 60_000;

/** Продолжение группы, ждавшей сброса лимита подписки. */
export function limitResumePrompt(branch: string): string {
  return [
    'Прошлый ход группы упёрся в лимит подписки; лимит сброшен, панель продолжает работу.',
    'Сначала сверь состояние по фактам (git status, git log, свой транскрипт) — оборванные ' +
      'проверки запусти заново.',
    `Потом продолжи с места остановки в ветке ${branch}.`,
  ].join('\n');
}

/** Продолжение группы после паузы человека. */
export function pauseResumePrompt(branch: string): string {
  return [
    'Человек поставил группу на паузу и теперь продолжает её. Ход, шедший до паузы, был ' +
      'остановлен: незаписанное в файлы могло пропасть.',
    'Сначала сверь состояние по фактам (git status, git log, свой транскрипт), потом продолжи ' +
      `с места остановки в ветке ${branch}.`,
  ].join('\n');
}

/** Группы, которые можно поставить на паузу: работают или ждут. */
const PAUSABLE: readonly SplitPlanGroupRecord['status'][] = ['started', 'background', 'awaiting'];

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
    if (group.status === 'done' || group.status === 'failed') continue;
    group.status = chat.started ? 'started' : 'failed';
    if (!chat.started) group.error = serverText('split-group-run-not-started');
  }
  for (const failure of result.failures) {
    const group = record.groups.find((item) => item.index === failure.index);
    if (!group) continue;
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
  private readonly deps: SplitConveyorDeps;
  /** Когда поставлен таймер сброса лимита (мс); таймер один на все записи. */
  private limitWakeAt: number | undefined;
  /**
   * Номер последнего поставленного таймера. Отменить таймер нельзя, а более
   * ранний срок другого провайдера (m11) ставит новый поверх: старый, сработав,
   * продолжил бы те же группы второй раз — он узнаёт себя устаревшим по номеру.
   */
  private limitWakeToken = 0;

  constructor(deps: SplitConveyorDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
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

    const prompt = triageStagePrompt({
      ...(input.proposal.shared ? { shared: input.proposal.shared } : {}),
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
    const applied = scan?.plan ? applySplitPlan(record.proposal.groups, scan.plan) : undefined;

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
        state.after = group.after;
        if (group.hold) state.hold = group.hold;
        state.status = group.hold ? 'held' : group.after.length > 0 ? 'waiting' : 'pending';
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

    return applied
      ? { kind: 'notice', code: 'triageApplied', text: `Разбор применён — ${summary}.` }
      : {
          kind: 'notice',
          code: 'triageMissing',
          text: `Разбор не получен (${finished.ok ? 'блока в ответе нет' : 'прогон не завершился'}) — группы стартуют как предложено: ${summary}.`,
        };
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
      this.apply(group, { ...unverified, status: 'awaiting', waitingFor: 'delivery' });
      this.deps.store.set(record);
      this.verifyDelivery(record.parentChatId, group.index, outcome);
      return;
    }
    this.settle(record, group, outcome);
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
    // Ход дошёл до конца — обрыв позади, и счёт самостоятельных продолжений
    // начинается заново.
    if (outcome.waitingFor !== 'interrupted') {
      delete group.interruptedAt;
      delete group.interruptResumes;
    }
    // Срок сброса лимита — только у хода, упёршегося в лимит (журнал 89).
    if (outcome.waitingFor === 'limit' && outcome.limitUntil) group.limitUntil = outcome.limitUntil;
    else delete group.limitUntil;
    // Предложения тикетов копятся через ходы, без повторов (95b).
    if (outcome.tickets?.length) {
      group.tickets = mergeSplitTickets(group.tickets, outcome.tickets, this.now().toISOString());
    }
    if (outcome.humanSteps?.length) {
      group.humanSteps = mergeSplitHumanSteps(
        group.humanSteps,
        outcome.humanSteps,
        this.now().toISOString(),
      );
    }
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
    // Лимит на исходе (аудит 25.09, L63): тот же путь, что у отказа, — очередь
    // до сброса не заводит новых групп и сама продолжится после него, — но
    // идущие группы не останавливаются: их ход прошёл.
    else if (outcome.limitWarningUntil) this.noteLimit(record, outcome.limitWarningUntil, true);
    // Группа ждёт (человека, фон, повтор) — место она держит (M7): ответ
    // человека продолжит её в этом же месте, а не сверх потолка. Ждавших её это
    // не отпускает: они стоят до `done`/`failed`.
    if (outcome.status !== 'done' && outcome.status !== 'failed') return;

    // Сверка веток (Т6) — до запуска ждавших: работа этой группы уже легла, и
    // считать её пересечения можно прямо сейчас. Оно асинхронное и отдельное:
    // ни один отказ git не должен помешать соседям стартовать.
    this.deps.watchOverlap?.(record.parentChatId);

    void this.launchNext(record).catch((error) => {
      this.deps.log('split conveyor: launch after chain end failed', error);
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
      .facts(group, outcome.mr ?? group.mr, copyRootOf(record))
      .catch((error: unknown): DeliveryVerdict => {
        // Недоступный удалённый приходит ответом (`unreachable` от ls-remote), а
        // не исключением. Исключение — это сама копия: git status/rev-parse не
        // прочли её (каталог снесён, репозиторий сломан). Ждать тут нечего — 3
        // коротких и 16 долгих попыток держали бы место четыре часа ради сбоя.
        this.deps.log('split conveyor: delivery facts failed', error);
        return { missing: [], failed: error instanceof Error ? error.message : String(error) };
      })
      .then((verdict) => this.onDeliveryFacts(parentChatId, index, outcome, verdict, settled));
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
    const schedule = this.deps.delivery?.schedule ?? setTimeout;
    const again = (asSettled: boolean, ms: number): void => {
      schedule(() => this.verifyDelivery(parentChatId, index, outcome, asSettled), ms);
    };

    if (verdict.failed) {
      delete group.deliveryChecks;
      delete group.blockedSince;
      this.settle(record, group, {
        ...withoutMr(outcome),
        status: 'failed',
        error: serverText('split-delivery-local-failed', { reason: verdict.failed.slice(0, 300) }),
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
      this.settle(record, group, {
        ...withoutMr(outcome),
        status: 'failed',
        error: serverText('split-delivery-unverifiable', {
          checks,
          reason: verdict.unreachable,
        }),
      });
      return;
    }
    delete group.blockedSince;
    delete group.deliveryChecks;

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
    // Готовность по следам звеньев — вместе с фактами git (аудит 25.09, L110).
    verdict = { ...verdict, missing: [...verdict.missing, ...stageTraceGaps(group.stageTrace)] };

    if (verdict.missing.length === 0) {
      delete group.deliveryMissing;
      delete group.deliveryNudges;
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

    group.deliveryMissing = verdict.missing;
    const nudges = group.deliveryNudges ?? 0;
    if (nudges < MAX_DELIVERY_NUDGES && group.chatId && group.path) {
      const sent = this.deps.delivery?.nudge(
        group,
        this.withIdentity(record, group, deliveryNudgePrompt(group.branch, verdict.missing)),
      );
      if (sent === 'sent' || sent === 'queued') {
        group.deliveryNudges = nudges + 1;
        this.deps.store.set(record);
        return;
      }
    }
    this.settle(record, group, {
      ...withoutMr(outcome),
      status: 'failed',
      error: deliveryIncompleteText(verdict.missing),
    });
  }

  /**
   * После перезапуска панели: проверки доставки, оборванные вместе с прежним
   * процессом, идут заново — иначе группа стояла бы «проверяю» вечно, а
   * ждавшие её — вместе с ней.
   */
  recoverDeliveryChecks(): void {
    for (const record of Object.values(this.deps.store.all())) {
      for (const group of record.groups) {
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
    const record = link.parentChatId ? this.deps.store.get(link.parentChatId) : undefined;
    const group =
      record?.groups.find((item) => item.index === link.groupIndex) ??
      record?.groups.find((item) => link.branch && item.branch === link.branch);
    return group?.deliver === true;
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
    const prompt = this.withIdentity(record, group, interruptResumePrompt(group.branch));
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
    // Копии больше нет ни у кого, кто её делил: иначе у соседа по ней — из
    // того же или прошлого плана — осталась бы кнопка уборки несуществующего.
    for (const other of [...record.groups, ...(record.retiredGroups ?? [])]) {
      if (other.path && !other.cleaned && norm(other.path) === norm(path)) other.cleaned = cleaned;
    }
    this.deps.store.set(record);
    return cleaned;
  }

  /**
   * Завести группы заново из сохранённого итога разбора — без второго разбора.
   *
   * Нужен, когда группы стартовали НЕ ТАМ (живой прогон 24.09.2026: восемь групп
   * в одном подкаталоге, без копий): разбор на потолке стоит минуты, и его итог
   * верен — неверен был каталог. Незакрытые группы теряют чаты (`discard`
   * останавливает прогон и снимает связь) и встают в очередь заново; закрытые
   * (`done`) не трогаются. Решение человека: панель сама ничего не перезапускает.
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
        'deliveryChecks',
        'blockedSince',
        'mr',
        'cleaned',
        'mrWatch',
        'acceptedAt',
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

  /** Заводы тикетов в полёте: двойной клик не заводит одну находку дважды. */
  private readonly filing = new Map<string, Promise<string>>();

  /**
   * Завести предложенный тикет в трекере (L277): человек подтвердил в хабе.
   * Заводит `create` (запись в чужой сервис — дело маршрута), конвейер отвечает
   * за «один дефект — одна задача»: уже заведённый ключ возвращается как есть,
   * одновременный второй вызов ждёт первый, а отметка ложится на тот же дефект
   * во всех группах.
   */
  async fileTicket(
    parentChatId: string,
    key: string,
    create: (ticket: SplitTicketView, projectKey: string) => Promise<string>,
  ): Promise<{ key: string; created: boolean }> {
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
    const slot = `${parentChatId}|${key}`;
    const running = this.filing.get(slot);
    if (running) return { key: await running, created: false };
    const job = create(first.ticket, projectKey);
    this.filing.set(slot, job);
    try {
      const issueKey = await job;
      // Запись перечитывается: пока трекер отвечал, конвейер мог её сменить.
      const fresh = this.deps.store.get(parentChatId);
      if (fresh) {
        const at = this.now().toISOString();
        for (const group of fresh.groups) {
          for (const ticket of group.tickets ?? []) {
            if (splitTicketKey(ticket) === key) ticket.filed = { key: issueKey, at };
          }
        }
        this.deps.store.set(fresh);
      }
      return { key: issueKey, created: true };
    } finally {
      this.filing.delete(slot);
    }
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
        ...(group.deliver !== undefined ? { deliver: group.deliver } : {}),
        ...(group.interruptedAt ? { interruptedAt: group.interruptedAt } : {}),
        ...(group.interruptResumes ? { interruptResumes: group.interruptResumes } : {}),
        ...(group.cleaned ? { cleaned: group.cleaned } : {}),
        ...(group.pausedAt ? { pausedAt: group.pausedAt } : {}),
        ...(group.limitUntil ? { limitUntil: group.limitUntil } : {}),
        ...(group.parked ? { parkedAt: group.parked.at } : {}),
        ...(group.acceptedAt ? { acceptedAt: group.acceptedAt } : {}),
        ...(group.tickets?.length ? { tickets: group.tickets } : {}),
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
   * место отдаёт (журнал 81a) — её продолжение спрашивает место заново.
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
    return record.groups.filter(
      (group) =>
        group.status === 'started' || group.status === 'background' || group.status === 'awaiting',
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
    if (plain.length > 0) results.push(await this.runPortion(record, plain, undefined));
    for (const index of answered) {
      results.push(await this.runPortion(record, [index], this.contextFor(record, index)));
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
    const results: TaskSplitResult[] = [];
    for (const group of this.ordered(record)) {
      if (group.status !== 'waiting' || this.unmet(record, group).length > 0) continue;
      // Места нет — группа остаётся `waiting` без неудовлетворённых
      // предшественников и стартует со следующим освободившимся местом. Лимит
      // подписки держит её так же — до сброса (журнал 81b).
      if (this.slots(record) === 0 || this.limitedUntil(providerOf(record))) break;
      results.push(
        await this.runPortion(record, [group.index], this.contextFor(record, group.index)),
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
  private claimBranch(record: SplitPlanRecord, index: number, branch: string): void {
    const group = record.groups[index];
    if (!group || !branch || group.branch === branch) return;
    group.branch = branch;
    this.deps.store.set(record);
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

  private async runPortion(
    record: SplitPlanRecord,
    groups: number[],
    context: SplitGroupContext | undefined,
  ): Promise<TaskSplitResult> {
    // Статус «стартует» ставится ДО запуска: копии заводятся секунды, и второй
    // вызов за это время (ещё один конец цепочки) не должен завести те же группы.
    const at = this.now().toISOString();
    for (const index of groups) {
      const group = record.groups[index];
      if (!group) continue;
      group.status = 'started';
      group.startedAt = at;
      if (context?.base) group.base = context.base;
    }
    this.deps.store.set(record);

    let result: TaskSplitResult;
    try {
      result = await this.deps.launch(record, groups, context, (index, branch) =>
        this.claimBranch(record, index, branch),
      );
    } catch (error) {
      for (const index of groups) {
        const group = record.groups[index];
        if (!group) continue;
        group.status = 'failed';
        group.error = error instanceof Error ? error.message : String(error);
      }
      this.deps.store.set(record);
      throw error;
    }
    absorb(record, result, at);
    this.deps.store.set(record);
    return result;
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
      this.deps.store.set(record);
      if (this.admission(record).kind !== 'ok') return 'queued';
      // Итог — настоящий (m12): продолжение могли и не принять, и тогда
      // наблюдатель MR должен знать, что слово не дошло.
      return this.drainParked(parentChatId).get(index) ?? 'queued';
    }
    return this.deps.resume(group, this.withIdentity(record, group, prompt));
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
   * Пауза группы человеком (журнал 81a). Место под потолком освобождается
   * сразу — следующая из очереди стартует; ждавшие её остаются ждать: пауза не
   * «готово». Возвращает чаты группы — их прогон маршрут остановит сам.
   */
  pause(parentChatId: string, index: number): { chatIds: string[] } {
    const record = this.deps.store.get(parentChatId);
    const group = record?.groups[index];
    if (!record || !group || !PAUSABLE.includes(group.status)) {
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
   * «Продолжить» группу с паузы. Занимает место: потолок полон или лимит
   * исчерпан — отказ с числами, а с согласием человека (`force`) — сверх.
   */
  resumePaused(parentChatId: string, index: number, force = false): 'sent' | 'queued' {
    const record = this.deps.store.get(parentChatId);
    const group = record?.groups[index];
    if (!record || !group || group.status !== 'paused') {
      throw coded(new Error('Группа не на паузе — продолжать нечего'), 'split-resume-not-paused');
    }
    if (!force) this.admit(record);
    const prompt = this.withIdentity(record, group, pauseResumePrompt(group.branch));
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
    if (!force) this.admit(record);
    return this.runPortion(
      record,
      [index],
      group.holdAnswer ? this.contextFor(record, index) : undefined,
    );
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
    }
  }

  /** Пауза: запись и место в очереди (без остановки прогона — это дело маршрута). */
  private hold(record: SplitPlanRecord, group: SplitPlanGroupRecord): void {
    group.status = 'paused';
    group.pausedAt = this.now().toISOString();
    delete group.waitingFor;
    delete group.limitUntil;
    delete group.parked;
    delete group.interruptedAt;
    this.deps.store.set(record);
    void this.launchNext(record).catch((error) => {
      this.deps.log('split conveyor: launch after pause failed', error);
    });
  }

  /** Есть ли место для работы сейчас: лимит подписки, потом потолок. */
  private admission(
    record: SplitPlanRecord,
  ):
    | { kind: 'ok' }
    | { kind: 'ceiling'; running: number; limit: number }
    | { kind: 'limit'; until: string } {
    const until = this.limitedUntil(providerOf(record));
    if (until) return { kind: 'limit', until };
    const limit = this.deps.parallel?.(record);
    if (!limit || limit < 1) return { kind: 'ok' };
    const running = this.occupied(record);
    return running >= limit ? { kind: 'ceiling', running, limit } : { kind: 'ok' };
  }

  /** Отказ человеку, когда места нет, — с числами, чтобы он решил про «сверх». */
  private admit(record: SplitPlanRecord): void {
    const verdict = this.admission(record);
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
      const dates = [record.limitUntil];
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
    if (!Number.isFinite(at) || (warning && at <= this.now().getTime())) return;
    const known = record.limitUntil ? Date.parse(record.limitUntil) : 0;
    if (at > known) {
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
    } else if (!warning && record.limitWarning) {
      delete record.limitWarning;
      this.deps.store.set(record);
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
    const prompt = this.withIdentity(record, group, limitResumePrompt(group.branch));
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
      const prompt = group.parked.prompt;
      delete group.parked;
      this.deps.store.set(current);
      const outcome =
        this.deps.resume && group.chatId && group.path
          ? this.deps.resume(group, prompt)
          : 'refused';
      outcomes.set(index, outcome);
      if (outcome === 'refused') {
        this.deps.log(`split conveyor: parked resume refused (${parentChatId}#${index})`);
      }
    }
    return outcomes;
  }
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
