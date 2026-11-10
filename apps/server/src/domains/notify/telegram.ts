import { basename } from 'node:path';
import type { TelegramEvent, TelegramLastSend, TelegramSettings } from '@agentdeck/contracts';
import { TELEGRAM_DONE_AFTER_MINUTES } from '@agentdeck/contracts/integrations';
import type { RunNotice } from './run-notice.types.ts';
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
import { DIVIDER } from './telegram-answers/compose.ts';
import { digestParts } from './telegram-notices/compose.ts';
import { quietAt } from './telegram-notices/quiet.ts';
import type { HeldLine } from './telegram-notices/telegram-notices.types.ts';
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
  /**
   * Строка потока ядра (пересылка рантайма) → уведомления о задачах ядра в маршрутах ответов
   * (этап 12, P191). Маршруты ставят его, когда собрали уведомления; не стоит — строка пропадает.
   */
  coreLine?: (
    task: { taskId: string; title: string | null },
    event: { event: string | null },
  ) => void;
  /**
   * Вопросы ядра идут кнопками бота ответов (этап 12, D29, P188): маршруты ставят его, пересылка
   * тогда не шлёт их текстом. Не стоит — текст со ссылкой, как прежде.
   */
  coreButtons?: () => boolean;
}

/**
 * Удержанное тихими часами (этап 12, P194): общий с уведомлениями ядра файл
 * `telegram-notices.json` (`noticesStoreAt`) — строки переживают перезапуск панели.
 */
export interface TelegramHeldLines {
  heldLines(): HeldLine[];
  setHeldLines(lines: readonly HeldLine[]): void;
}

export type TelegramNotice = RunNotice | TestFailedNotice | BudgetNotice;

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
  /**
   * Тихие часы (`settings.quiet`): готовое к отправке, кроме прав и вопросов (они блокируют
   * агента и ждут только при `quiet.asks`), ложится сюда и уходит одной сводкой в конце окна.
   * Не задано — тишины у этого уведомителя нет.
   */
  held?: TelegramHeldLines;
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
  const quiet = createQuietHold(deps);
  const deliver = (notice: TelegramNotice, turn?: TurnEnd): void => {
    const settings = deps.settings();
    if (!settings.enabled || !settings.chatId) return;
    const token = deps.token();
    if (!token) return;
    if (quiet.hold(settings, notice, turn)) return;
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

/** Повтор сводки, которую Telegram не принял: через минуту, не раньше. */
const FLUSH_RETRY_MS = 60_000;

/**
 * Тихие часы уведомителя прогонов (этап 12, P194). Внутри окна готовый текст ложится в общий
 * файл удержанного (`held`) и не уходит; права и вопросы блокируют агента — держатся, только
 * если `quiet.asks`. В конце окна (таймер) и при старте панели (удержанное до перезапуска)
 * — одна сводка на чат, разрезанная по пределу сообщения; ушедшая часть снимается сразу.
 */
function createQuietHold(deps: TelegramDeps) {
  const now = (): number => (deps.now ?? Date.now)();
  let armed = false;
  const arm = (ms: number): void => {
    if (armed) return;
    armed = true;
    (deps.schedule ?? later)(
      () => {
        armed = false;
        void flush().catch((error: unknown) => (deps.onError ?? warnSendFailed)(error));
      },
      Math.max(ms, 1_000),
    );
  };
  const flush = async (): Promise<void> => {
    const held = deps.held;
    const lines = held?.heldLines() ?? [];
    if (!held || lines.length === 0) return;
    const window = quietAt(deps.settings().quiet, now());
    if (window.inside) {
      arm((window.endsAt ?? now()) - now() + 1_000);
      return;
    }
    const token = deps.token();
    if (!token) return;
    for (const chatId of [...new Set(lines.map((line) => line.chatId))]) {
      const own = held.heldLines().filter((line) => line.chatId === chatId);
      for (const part of digestParts(own.map((line) => `${DIVIDER}\n${line.text}`))) {
        const result = await deliverTelegram(token, chatId, part.text, deps.delivery);
        if (!result.ok) {
          arm(FLUSH_RETRY_MS);
          throw new Error(safeDetail(result.error));
        }
        const gone = new Set(own.splice(0, part.count));
        held.setHeldLines(held.heldLines().filter((line) => !gone.has(line)));
      }
    }
  };
  // Удержанное до перезапуска: окно кончилось, пока панель лежала, — сводка вскоре после старта.
  if (deps.held?.heldLines().length) arm(1_000);
  return {
    hold(settings: TelegramSettings, notice: TelegramNotice, turn?: TurnEnd): boolean {
      if (!deps.held) return false;
      const window = quietAt(settings.quiet, now());
      if (!window.inside) return false;
      const asks = notice.kind === 'permission' || notice.kind === 'question';
      if (asks && !settings.quiet?.asks) return false;
      deps.held.setHeldLines([
        ...deps.held.heldLines(),
        { chatId: settings.chatId, text: noticeText(deps, notice, turn), at: now() },
      ]);
      arm((window.endsAt ?? now()) - now() + 1_000);
      return true;
    },
  };
}

/** Текст уведомления, как ушёл бы сам, — для строки сводки тишины. */
function noticeText(deps: TelegramDeps, notice: TelegramNotice, turn?: TurnEnd): string {
  const panelChat = 'chatId' in notice ? notice.chatId : undefined;
  const openId = panelChat ? (deps.openIdOf?.(panelChat) ?? panelChat) : undefined;
  return telegramText(notice, titleSafe(deps, notice), openId, viaOf(deps, notice, openId), turn);
}

/**
 * Подписан ли Telegram на событие. «Закончил» судится порогом длительности, а не
 * галочкой `runDone`: о каждом ходе — шум, о часовой работе — то, ради чего
 * уведомление и нужно.
 */
function subscribed(settings: TelegramSettings, notice: TelegramNotice): boolean {
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
 * Текст Telegram разметкой HTML. События прогона — `composeRich`; бюджет — своей
 * строкой. Вебхук и push получают прежнюю строку `compose`.
 */
function telegramText(
  notice: TelegramNotice,
  title: string | undefined,
  openId: string | undefined,
  via: string | undefined,
  turn?: TurnEnd,
): string {
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
