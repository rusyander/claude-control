import { basename } from 'node:path';
import type { TelegramEvent, TelegramLastSend, TelegramSettings } from '@agentdeck/contracts';
import type { GroupSignalSeverity, GroupWatchRule } from '@agentdeck/contracts/group-watch';
import { TELEGRAM_DONE_AFTER_MINUTES } from '@agentdeck/contracts/integrations';
import type { RunNotice } from '../chat/ChatRunRegistry/ChatRunRegistry.ts';
import { describeFailure, failureCode, parseJson, sendRequest } from '../integrations/http/http.ts';
import { unreachable } from '../integrations/errors.ts';
import type { CodedText } from '../../lib/server-text/server-text.ts';
import { safeDetail, telegramApiBase } from './telegram-api.ts';
import { deliverTelegram, type DeliveryOptions } from './telegram-delivery.ts';
import { composeRich, composeSignal } from './telegram-text.ts';
import { classifyTurnEnd } from './turn-end/turn-end.ts';
import type { TurnEnd } from './turn-end/turn-end.types.ts';
import { escapeHtml } from './telegram-answers/html.ts';
import type { ChatRoute } from './telegram-answers/telegram-answers.types.ts';
import { parseForeignChatKey } from '@agentdeck/contracts/foreign-chat-key';

/**
 * Уведомления в Telegram — второй адресат тех же событий, что уходят на телефон.
 *
 * Зачем второй: push от Expo приходит в ПРИЛОЖЕНИЕ панели, и его получает
 * только тот, у кого оно установлено и спарено. Telegram получает и владелец без
 * приложения, и общий чат команды, куда стоит уронить строку «регресс упал».
 *
 * НАРУЖУ УХОДЯТ ИМЯ И СУТЬ, НЕ СОДЕРЖИМОЕ (решение владельца 25.10.2026): вид
 * события, имя папки проекта, имя чата и одна строка сути — инструмент,
 * текст вопроса под маской секретов, число упавших тестов, класс ошибки
 * (`telegram-text.ts`). Ни кода, ни путей, ни промпта, ни ответа агента: бот —
 * чужой сервер. Вебхук и push по-прежнему получают только заголовок (`compose`).
 *
 * Отправка НИКОГДА не ждёт и никого не задерживает: прогон уже кончился, а
 * единственное, чем сеть может помешать, — задержать ответ следующему запросу.
 */

// Адрес Bot API и вычистка токена живут отдельно: их же берёт клиент ответов
// (`telegram-answers/bot-api.ts`), а этот модуль сам зовёт его отправку.
export { safeDetail, telegramApiBase };
const apiBase = (): string => telegramApiBase();
const SYSTEM = 'Telegram';

/** Провал теста — повод, которого у push-уведомлений нет. */
export interface TestFailedNotice {
  kind: 'testFailed';
  chatId: string;
  projectPath?: string;
  /** Сколько кейсов провалено — единственное число в тексте. */
  failed: number;
  total?: number;
}

/**
 * Бюджет контура перешёл порог — повод, которого у прогонов нет вовсе.
 *
 * Ни чата, ни проекта у него не бывает: бюджет — свойство КОНТУРА, а тратят его
 * все прогоны разом. Поэтому `projectPath` объявлен невозможным, а не пустым:
 * подставленное сюда имя папки читалось бы как «этот проект исчерпал бюджет».
 */
export interface BudgetNotice {
  kind: 'budgetNear' | 'budgetOver';
  /** Контур по имени, которое дал ему человек: идентификатор он не читает. */
  platformTitle: string;
  /** Доля бюджета от 0 до 1 — единственное число в тексте. */
  share: number;
  projectPath?: undefined;
}

/**
 * Место, куда опрос ответов из Telegram подставляет «права и вопросы доставляю
 * я». Отправитель собирается раньше опроса (опрос живёт в маршрутах), поэтому
 * ответ читается при каждой отправке, а не запоминается.
 */
export interface TelegramAnswersCover {
  covers: () => boolean;
}

export type TelegramNotice = RunNotice | TestFailedNotice | BudgetNotice | GroupSignalNotice;

export interface TelegramDeps {
  settings: () => TelegramSettings;
  /** Токен бота из зашифрованного хранилища; нет — молчим. */
  token: () => string | undefined;
  /**
   * Куда сообщить о неудачной отправке. Не задан — предупреждение в журнал
   * сервера: молчаливый отказ прятал бы пропавший сигнал сторожа, а тихий период
   * после него уже начался и повтора не будет.
   */
  onError?: (error: unknown) => void;
  /** Имя чата по его ключу — вторая строка текста; нет — строки нет. */
  titleOf?: (chatId: string) => string | undefined;
  /** Ключ чата для ссылки «Открыть чат →»: временный `new-…` — его сессия. */
  openIdOf?: (chatId: string) => string;
  /** Имя CLI по id провайдера («Codex») — для первой строки чужих разговоров. */
  cliNameOf?: (providerId: string) => string | undefined;
  /**
   * Ответы из Telegram включены и опрос жив: права и вопросы доставит их
   * сообщение с кнопками, и второе, без кнопок, только дублировало бы его.
   */
  answersCover?: () => boolean;
  /** Итог каждой отправки — на карточку Telegram («Последняя отправка»). */
  onResult?: (result: TelegramLastSend) => void;
  /**
   * Отправленное сообщение — номер для /clear и чат, куда уйдёт ответ на него
   * (reply владельца): `sent-log.ts`.
   */
  onSent?: (chatId: string, messageId: number, route?: ChatRoute) => void;
  /** Пауза перед повтором и часы — подменяются в тестах. */
  delivery?: DeliveryOptions;
  now?: () => number;
  /**
   * Чат снова работает (следующий ход, автопродолжение, ответ из очереди) —
   * спрашивается через `settleMs` после конца хода: конец, за которым сразу
   * пошла работа, — промежуточный.
   */
  busy?: (chatId: string) => boolean;
  /** Чат — звено группы: о его шагах Telegram молчит, итог скажет группа. */
  subtask?: (chatId: string) => boolean;
  /** Сколько ждать после конца хода прогона панели, прежде чем судить его. */
  settleMs?: number;
  /** Отложенный запуск — подменяется в тестах. */
  schedule?: (run: () => void, ms: number) => void;
}

/** Пауза перед судом о конце хода прогона панели: продолжения стартуют за секунды. */
export const TURN_SETTLE_MS = 20_000;
/** Сколько чатов помнить, чтобы одна карточка хода не ушла дважды. */
const CARDS_MAX = 500;

const later = (run: () => void, ms: number): void => {
  const timer = setTimeout(run, ms);
  timer.unref?.();
};

/**
 * Вид события панели → имя события в настройке подписки. Общий для всех
 * адресатов: подписка у Telegram и у вебхука одна и та же, и раздваивать это
 * правило нельзя — иначе «мне приходит в Telegram, а в вебхук нет» станет
 * законным поведением.
 */
export function noticeEvent(notice: TelegramNotice): TelegramEvent {
  switch (notice.kind) {
    case 'done':
      return 'runDone';
    case 'error':
      return 'runError';
    case 'permission':
      return 'permission';
    case 'question':
      return 'question';
    case 'budgetNear':
    case 'budgetOver':
      // Одно событие подписки на оба порога: подписка отвечает на вопрос
      // «сообщать ли про бюджет», а какой именно порог — сказано в тексте.
      return 'budget';
    case 'groupSignal':
      return 'groupSignal';
    default:
      return 'testFailed';
  }
}

/** Текст сообщения. Читает его человек — поэтому по-русски и одной строкой. */
export function compose(notice: TelegramNotice): string {
  const project = notice.projectPath ? basename(notice.projectPath) : 'Домашний чат';
  switch (notice.kind) {
    case 'done':
      return `✅ Работа закончена — ${project}`;
    case 'error':
      return `⛔ Прогон упал — ${project}`;
    case 'permission':
      return `🔐 Нужно разрешение — ${project}${notice.toolName ? `: ${notice.toolName}` : ''}`;
    case 'question':
      return `❓ Агент задал вопрос — ${project}`;
    // Оценка, а не факт: остатка бюджета контур наружу не отдаёт (подпись
    // `budget-manual`), и обещать здесь точную цифру было бы враньём.
    case 'budgetNear':
      return `⚠️ Бюджет контура «${notice.platformTitle}» израсходован примерно на ${Math.round(
        notice.share * 100,
      )} %`;
    case 'budgetOver':
      return `⛔ Оценка расхода контура «${notice.platformTitle}» дошла до введённого бюджета`;
    case 'groupSignal':
      return composeGroupSignal(notice);
    default:
      return `🔴 Тесты провалены (${notice.failed}${
        notice.total ? ` из ${notice.total}` : ''
      }) — ${project}`;
  }
}

/**
 * Отправить одно сообщение. Возвращает промис — им пользуется кнопка «Проверить
 * связь», которой нужен честный ответ, а не «отправлено куда-то».
 */
export async function sendTelegramMessage(
  token: string,
  chatId: string,
  text: string,
): Promise<void> {
  const response = await sendRequest({
    url: `${apiBase()}/bot${token}/sendMessage`,
    // Токен бота — ЧАСТЬ АДРЕСА. Без этой подписи он уехал бы в подробность
    // отказа, а оттуда в ответ API и в журнал панели.
    label: `${apiBase()}/bot<токен>/sendMessage`,
    method: 'POST',
    system: SYSTEM,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  if (!response.ok) {
    throw Object.assign(
      unreachable(safeDetail(describeFailure(SYSTEM, response)), safeDetail(response.text)),
      safeCode(failureCode(SYSTEM, response)),
    );
  }
}

/**
 * Кто мы для Telegram: имя бота. Это и есть проверка связи — `getMe` ничего не
 * шлёт в чат, поэтому кнопку «Проверить» можно жать сколько угодно.
 */
export async function telegramMe(token: string): Promise<string> {
  const response = await sendRequest({
    url: `${apiBase()}/bot${token}/getMe`,
    label: `${apiBase()}/bot<токен>/getMe`,
    system: SYSTEM,
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw Object.assign(
      unreachable(safeDetail(describeFailure(SYSTEM, response)), safeDetail(response.text)),
      safeCode(failureCode(SYSTEM, response)),
    );
  }
  const me = parseJson<{ result?: { username?: string; first_name?: string } } | null>(
    SYSTEM,
    response,
  );
  return me?.result?.username
    ? `@${me.result.username}`
    : (me?.result?.first_name ?? 'бот без имени');
}

/**
 * Отправитель для реестров прогонов: та же форма, что у push-уведомителя.
 * Выключено, нет токена, нет чата или событие не подписано — тишина, без единого
 * запроса наружу. Права и вопросы молчат и тогда, когда их уже доставляют
 * ответы из Telegram (`answersCover`).
 *
 * Конец хода (`done`) уходит только карточкой «Задача закрыта» или «Агент ждёт
 * вас» (`turn-end/`); промежуточная остановка молчит. Прогон панели судится
 * через `settleMs`: за это время видно, пошла ли работа дальше. Сессия вне
 * панели уже выждала своё (`outside-done.ts`).
 */
export function createTelegramNotifier(deps: TelegramDeps): (notice: TelegramNotice) => void {
  const cards = new Map<string, string>();
  const deliver = (notice: TelegramNotice, turn?: TurnEnd): void => {
    const settings = deps.settings();
    if (!settings.enabled || !settings.chatId) return;
    const token = deps.token();
    if (!token) return;
    void send(deps, token, settings.chatId, notice, turn).catch((error: unknown) => {
      // Нет сети, лёг сервис, бот выкинут из чата — уведомление просто не дошло.
      // Состояние панели от этого не меняется, и падать тут не с чего.
      (deps.onError ?? warnSendFailed)(error);
    });
  };
  return (notice) => {
    const settings = deps.settings();
    if (!settings.enabled || !settings.chatId) return;
    if (!subscribed(settings, notice)) return;
    if ((notice.kind === 'permission' || notice.kind === 'question') && deps.answersCover?.()) {
      return;
    }
    if (!deps.token()) return;
    if (notice.kind !== 'done') {
      deliver(notice);
      return;
    }
    const judge = (): void => {
      const turn = judgeTurn(deps, notice, cards);
      if (turn) deliver(notice, turn);
    };
    if (notice.outside) judge();
    else (deps.schedule ?? later)(judge, deps.settleMs ?? TURN_SETTLE_MS);
  };
}

/**
 * Конец хода — карточка или тишина. Промежуточный — тишина. Висящий вопрос
 * инструментом, который уже ушёл своим сообщением (вопрос посреди хода или
 * ответы с кнопками), второй раз не идёт. Одна карточка на ход и вид: тот же
 * ход, кончившийся «закрыта» повторно после позднего уведомления фона, молчит.
 */
function judgeTurn(
  deps: TelegramDeps,
  notice: RunNotice,
  cards: Map<string, string>,
): TurnEnd | undefined {
  let busy = false;
  let subtask = false;
  try {
    busy = deps.busy?.(notice.chatId) ?? false;
    subtask = deps.subtask?.(notice.chatId) ?? false;
  } catch {
    // Сбой справки о чате — судим по тому, что знает само уведомление.
  }
  const turn = classifyTurnEnd({
    ...notice,
    ...(busy || notice.continued ? { continued: true } : {}),
    ...(subtask ? { subtask: true } : {}),
  });
  if (turn.kind === 'intermediate') return undefined;
  const settings = deps.settings();
  if (
    turn.kind === 'waiting' &&
    notice.asked &&
    (settings.events.includes('question') || deps.answersCover?.())
  ) {
    return undefined;
  }
  if (notice.turnKey !== undefined) {
    const key = `${notice.turnKey}|${turn.kind}`;
    if (cards.get(notice.chatId) === key) return undefined;
    cards.delete(notice.chatId);
    cards.set(notice.chatId, key);
    if (cards.size > CARDS_MAX) cards.delete(cards.keys().next().value as string);
  }
  return turn;
}

/**
 * Подписан ли Telegram на событие. «Закончил» судится порогом длительности, а не
 * галочкой `runDone`: о каждом ходе — шум, о часовой работе — то, ради чего
 * уведомление и нужно.
 */
function subscribed(settings: TelegramSettings, notice: TelegramNotice): boolean {
  // Сигнал сторожа «внимание» — телеметрия (кэш, окна, расход, дубли вопросов):
  // в Telegram уходит только «тревога» (решение владельца 25.10.2026).
  if (notice.kind === 'groupSignal' && notice.severity !== 'alert') return false;
  if (notice.kind !== 'done') return settings.events.includes(noticeEvent(notice));
  const minutes = settings.doneAfterMinutes ?? TELEGRAM_DONE_AFTER_MINUTES;
  return minutes > 0 && (notice.durationMs ?? 0) >= minutes * 60_000;
}

async function send(
  deps: TelegramDeps,
  token: string,
  chatId: string,
  notice: TelegramNotice,
  turn?: TurnEnd,
): Promise<void> {
  const panelChat = 'chatId' in notice ? notice.chatId : undefined;
  const openId = panelChat ? (deps.openIdOf?.(panelChat) ?? panelChat) : undefined;
  const title = titleSafe(deps, notice);
  const text = telegramText(notice, title, openId, viaOf(deps, notice, openId), turn);
  const result = await deliverTelegram(token, chatId, text, deps.delivery);
  if (result.ok && result.messageId !== undefined) {
    deps.onSent?.(chatId, result.messageId, routeOf(notice, openId, title));
  }
  const at = new Date((deps.now ?? Date.now)()).toISOString();
  deps.onResult?.(
    result.ok ? { at, ok: true } : { at, ok: false, error: safeDetail(result.error) },
  );
  if (!result.ok) throw new Error(safeDetail(result.error));
}

/**
 * Текст Telegram разметкой HTML. События прогона — `composeRich`; сигнал
 * сторожа — «⚠️ ТРЕВОГА» словами, с чатом и группой, правило и числа в цитате
 * («внимание» в Telegram не уходит, `subscribed`); бюджет — своей
 * строкой. Вебхук и push получают прежнюю строку `compose`.
 */
function telegramText(
  notice: TelegramNotice,
  title: string | undefined,
  openId: string | undefined,
  via: string | undefined,
  turn?: TurnEnd,
): string {
  if (notice.kind === 'groupSignal') {
    // Словами: что с группой; группа, код правила и числа — в свёрнутой цитате.
    const parts = groupSignalParts(notice);
    const group = notice.group
      ? `группа ${notice.group.index}${notice.group.title ? ` «${notice.group.title}»` : ''}`
      : '';
    const details = [group, [notice.rule, parts.details].filter(Boolean).join(' · ')]
      .filter(Boolean)
      .join(' · ');
    return composeSignal({
      type: '⚠️ ТРЕВОГА',
      essence: GROUP_SIGNAL_TITLES[notice.rule] ?? parts.essence,
      ...(title ? { session: title } : {}),
      project: parts.project,
      details,
      ...(openId ? { openId } : {}),
    });
  }
  if (notice.kind === 'budgetNear' || notice.kind === 'budgetOver') {
    return composeSignal({ type: '💰 БЮДЖЕТ', essence: compose(notice).replace(/^\S+\s+/, '') });
  }
  const rich = notice.kind === 'done' && turn ? { ...notice, turn } : notice;
  return composeRich(rich, title, openId, via) ?? escapeHtml(compose(notice));
}

/**
 * Чужой CLI или сессия вне панели — в первую строку между проектом и сессией:
 * «📁 shop · Codex · …», «📁 shop · VS Code · …». Claude Code не пишется.
 */
function viaOf(
  deps: TelegramDeps,
  notice: TelegramNotice,
  openId: string | undefined,
): string | undefined {
  if ('outside' in notice && notice.outside) return 'VS Code';
  const foreign = openId ? parseForeignChatKey(openId) : undefined;
  if (!foreign) return undefined;
  return deps.cliNameOf?.(foreign.providerId) ?? foreign.providerId;
}

/**
 * Куда уйдёт ответ-reply на уведомление: чат панели (не чужого CLI — у него
 * своя отправка) или сессия вне панели. Бюджету отвечать некуда.
 */
function routeOf(
  notice: TelegramNotice,
  openId: string | undefined,
  title: string | undefined,
): ChatRoute | undefined {
  if (!openId || parseForeignChatKey(openId)) return undefined;
  return {
    chatId: openId,
    ...(notice.projectPath ? { projectPath: notice.projectPath } : {}),
    ...(title ? { title } : {}),
    ...('outside' in notice && notice.outside ? { outside: true, sessionId: openId } : {}),
  };
}

/** Имя чата не главнее самого уведомления: сбой поиска — без второй строки. */
function titleSafe(deps: TelegramDeps, notice: TelegramNotice): string | undefined {
  const chatId = 'chatId' in notice ? notice.chatId : undefined;
  if (!chatId || !deps.titleOf) return undefined;
  try {
    return deps.titleOf(chatId);
  } catch {
    return undefined;
  }
}

/** Отказ отправки в журнал: текст ошибки уже без токена (`label` запроса, `safeDetail`). */
function warnSendFailed(error: unknown): void {
  const text = error instanceof Error ? error.message : String(error);
  console.warn('[notify] telegram send failed:', safeDetail(text));
}

/** Параметры кода — тот же текст по частям: токен из них вычищается так же. */
function safeCode(code: CodedText): CodedText {
  const params = Object.fromEntries(
    Object.entries(code.params ?? {}).map(([key, value]) => [
      key,
      typeof value === 'string' ? safeDetail(value) : value,
    ]),
  );
  return { ...code, params };
}

/**
 * Сигнал сторожа групп (фаза 2, W.5): «внимание» и «тревога» — правило, числа
 * и имя папки проекта. Названия группы и текста вопроса здесь нет: это уже
 * содержимое разговора, а наружу уходит только заголовок.
 *
 * Подписка — тем же списком событий (`groupSignal`), что у всех адресатов:
 * отдельный выключатель у сторожа давал два источника одной подписки, и вебхук
 * сигналов не получал вовсе.
 */
export interface GroupSignalNotice {
  kind: 'groupSignal';
  rule: GroupWatchRule;
  severity: GroupSignalSeverity;
  numbers: Record<string, number>;
  projectPath?: string;
  stage?: string;
  /** Чат звена, где сработало: имя чата и ссылка в Telegram. */
  chatId?: string;
  /** Группа словами: номер (с 1) и имя. */
  group?: { index: number; title?: string };
}

/** Короткое имя правила для строки в Telegram — только правила, что туда уходят. */
const GROUP_SIGNAL_TITLES: Partial<Record<GroupWatchRule, string>> = {
  R1: 'группа молчит',
  R1b: 'вопрос ждёт ответа',
  R2: 'кэш остыл, окно переписано',
  R3: 'сжатия подряд',
  R4: 'одна проверка по кругу',
  R5: 'ревью на стадии работы',
  R6: 'пуш или MR раньше звена доставки',
  R9: 'пятичасовое окно к сбросу кончится',
  R11: 'цикл опроса со сном',
  R13: 'веер субагентов',
  R15: 'вызов упёрся в свой срок',
  R17: 'долгое ожидание очереди тяжёлых шагов',
  R20: 'группа действует на паузе',
  R21: 'тяжёлые проверки по кругу',
  R22: 'группа стоит без хода',
  R23: 'одна беда в нескольких группах',
  R24: 'тот же вызов падает той же ошибкой',
  R25: 'отбитое действие сделано другим путём',
  R26: 'останавливает чужие процессы',
  R27: 'вопрос текстом ждёт ответа',
  R28: 'напоминания о доставке впустую',
  R29: 'инструмента нет в сессии',
  R30: 'внешний сервис не отвечает',
  R31: 'правки вне своей копии',
  R33: 'вердикт ревью без блока',
  R34: 'новый разговор поверх тёплого',
  R35: 'переделка закоммиченного',
  R36: 'сервер звена пережил паузу',
};

/** Числа сигнала словами: человек читает строку, а не ключи кода. Неизвестный ключ — как есть. */
const GROUP_SIGNAL_NUMBERS: Record<string, (value: number) => string> = {
  idleMin: (value) => `без событий ${value} мин`,
  waitMin: (value) => `ждёт ${value} мин`,
  writeK: (value) => `переписано ${value}k токенов`,
  gapMin: (value) => `перерыв ${value} мин`,
  lostW: (value) => `потеря ≈${value} W`,
  count: (value) => `сжатий за час: ${value}`,
  runs: (value) => `запусков без правки: ${value}`,
  spawns: (value) => `спавнов: ${value}`,
  ops: (value) => `публикаций: ${value}`,
  nowPct: (value) => `сейчас ${value} %`,
  projectedPct: (value) => `к сбросу ≈${value} %`,
  resetMin: (value) => `сброс через ${value} мин`,
  polls: (value) => `циклов: ${value}`,
  subW: (value) => `расход субагентов ${value} W`,
  timeoutMin: (value) => `срок ${value} мин`,
  timeouts: (value) => `упоров в срок: ${value}`,
  ahead: (value) => `впереди в очереди: ${value}`,
  tools: (value) => `вызовов: ${value}`,
  afterMin: (value) => `через ${value} мин после паузы`,
  gates: (value) => `проходов тяжёлых проверок: ${value}`,
  totalMin: (value) => `всего ${value} мин`,
  fails: (value) => `падений: ${value}`,
  kills: (value) => `остановок: ${value}`,
  calls: (value) => `вызовов: ${value}`,
  failures: (value) => `сбоев: ${value}`,
  spanMin: (value) => `за ${value} мин`,
  writes: (value) => `действий вне копии: ${value}`,
  nudges: (value) => `напоминаний: ${value}`,
  groups: (value) => `групп: ${value}`,
  insertK: (value) => `вставок ${value} тыс. знаков`,
  prevK: (value) => `окно было ${value}k`,
  files: (value) => `файлов: ${value}`,
  ports: (value) => `портов: ${value}`,
};

/** Тот же ключ числа у правила значит другое: `afterMin` R25 — после отказа, не после паузы. */
const GROUP_SIGNAL_NUMBERS_BY_RULE: Partial<
  Record<GroupWatchRule, Record<string, (value: number) => string>>
> = {
  R25: { afterMin: (value) => `через ${value} мин после отказа` },
};

const STAGE_TITLES: Record<string, string> = {
  work: 'работа',
  review: 'ревью',
  deliver: 'доставка',
};

/** Сигнал сторожа по частям: правило с именем и числа со стадией — общие для обоих текстов. */
export function groupSignalParts(notice: GroupSignalNotice): {
  essence: string;
  details: string;
  project: string;
} {
  const title = GROUP_SIGNAL_TITLES[notice.rule];
  const own = GROUP_SIGNAL_NUMBERS_BY_RULE[notice.rule];
  const numbers = Object.entries(notice.numbers)
    .map(([key, value]) => (own?.[key] ?? GROUP_SIGNAL_NUMBERS[key])?.(value) ?? `${key} ${value}`)
    .join(', ');
  const stage = notice.stage ? `стадия «${STAGE_TITLES[notice.stage] ?? notice.stage}»` : '';
  return {
    essence: `${notice.rule}${title ? ` ${title}` : ''}`,
    details: [numbers, stage].filter(Boolean).join('; '),
    project: notice.projectPath ? basename(notice.projectPath) : '',
  };
}

export function composeGroupSignal(notice: GroupSignalNotice): string {
  const project = notice.projectPath ? basename(notice.projectPath) : '';
  const icon = notice.severity === 'alert' ? '⛔' : notice.severity === 'warn' ? '⚠️' : 'ℹ️';
  const title = GROUP_SIGNAL_TITLES[notice.rule];
  const own = GROUP_SIGNAL_NUMBERS_BY_RULE[notice.rule];
  const numbers = Object.entries(notice.numbers)
    .map(([key, value]) => (own?.[key] ?? GROUP_SIGNAL_NUMBERS[key])?.(value) ?? `${key} ${value}`)
    .join(', ');
  const stage = notice.stage ? `стадия «${STAGE_TITLES[notice.stage] ?? notice.stage}»` : '';
  const details = [numbers, stage].filter(Boolean).join('; ');
  return `${icon} ${notice.rule}${title ? ` ${title}` : ''}${details ? ` (${details})` : ''}${
    project ? ` — ${project}` : ''
  }`;
}
