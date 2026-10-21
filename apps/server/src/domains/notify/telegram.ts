import { basename } from 'node:path';
import type { TelegramEvent, TelegramSettings } from '@agentdeck/contracts';
import type { GroupSignalSeverity, GroupWatchRule } from '@agentdeck/contracts/group-watch';
import type { RunNotice } from '../chat/ChatRunRegistry/ChatRunRegistry.ts';
import { describeFailure, failureCode, parseJson, sendRequest } from '../integrations/http/http.ts';
import { unreachable } from '../integrations/errors.ts';
import type { CodedText } from '../../lib/server-text/server-text.ts';

/**
 * Уведомления в Telegram — второй адресат тех же событий, что уходят на телефон.
 *
 * Зачем второй: push от Expo приходит в ПРИЛОЖЕНИЕ панели, и его получает
 * только тот, у кого оно установлено и спарено. Telegram получает и владелец без
 * приложения, и общий чат команды, куда стоит уронить строку «регресс упал».
 *
 * НАРУЖУ УХОДИТ РОВНО ЗАГОЛОВОК: вид события и имя папки проекта. Ни промпта,
 * ни ответа агента, ни путей внутри проекта — та же граница, что и у Expo
 * (`domains/remote-notify.ts`), и по той же причине: содержимому разговора
 * незачем покидать машину. Бот — чужой сервер, и это решает всё.
 *
 * Отправка НИКОГДА не ждёт и никого не задерживает: прогон уже кончился, а
 * единственное, чем сеть может помешать, — задержать ответ следующему запросу.
 */

/**
 * Адрес Bot API. Переменная — шов проверок (`tools/qa/check-group-watch.mjs`
 * поднимает свой приёмник на loopback): настоящий сервер Telegram проверка
 * трогать не должна. Читается при каждой отправке.
 */
const apiBase = (): string => process.env.AGENTDECK_TELEGRAM_API || 'https://api.telegram.org';
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

export type TelegramNotice = RunNotice | TestFailedNotice | BudgetNotice;

export interface TelegramDeps {
  settings: () => TelegramSettings;
  /** Токен бота из зашифрованного хранилища; нет — молчим. */
  token: () => string | undefined;
  /** Куда сообщить о неудачной отправке. Не задан — тишина. */
  onError?: (error: unknown) => void;
}

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
 * запроса наружу.
 */
export function createTelegramNotifier(deps: TelegramDeps): (notice: TelegramNotice) => void {
  return (notice) => {
    const settings = deps.settings();
    if (!settings.enabled || !settings.chatId) return;
    if (!settings.events.includes(noticeEvent(notice))) return;
    const token = deps.token();
    if (!token) return;

    void sendTelegramMessage(token, settings.chatId, compose(notice)).catch((error: unknown) => {
      // Нет сети, лёг сервис, бот выкинут из чата — уведомление просто не дошло.
      // Состояние панели от этого не меняется, и падать тут не с чего.
      deps.onError?.(error);
    });
  };
}

/**
 * Хвост ответа для подробности отказа — с вырезанным токеном на случай, если
 * Telegram вернул его в тексте ошибки (он это делает, отвечая на битый адрес).
 */
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

function safeDetail(text: string): string {
  return text.replace(/bot\d+:[\w-]+/g, 'bot<токен>').slice(0, 300);
}

/**
 * Сигнал сторожа групп (фаза 2, W.5): «внимание» и «тревога» — правило, числа
 * и имя папки проекта. Названия группы и текста вопроса здесь нет: это уже
 * содержимое разговора, а наружу уходит только заголовок.
 *
 * Подписка у него своя (`groupWatch.telegram`), не список событий: сигнал —
 * не событие прогона, и вебхук его не получает.
 */
export interface GroupSignalNotice {
  rule: GroupWatchRule;
  severity: GroupSignalSeverity;
  numbers: Record<string, number>;
  projectPath?: string;
  stage?: string;
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
};

const STAGE_TITLES: Record<string, string> = {
  work: 'работа',
  review: 'ревью',
  deliver: 'доставка',
};

export function composeGroupSignal(notice: GroupSignalNotice): string {
  const project = notice.projectPath ? basename(notice.projectPath) : '';
  const icon = notice.severity === 'alert' ? '⛔' : notice.severity === 'warn' ? '⚠️' : 'ℹ️';
  const title = GROUP_SIGNAL_TITLES[notice.rule];
  const numbers = Object.entries(notice.numbers)
    .map(([key, value]) => GROUP_SIGNAL_NUMBERS[key]?.(value) ?? `${key} ${value}`)
    .join(', ');
  const stage = notice.stage ? `стадия «${STAGE_TITLES[notice.stage] ?? notice.stage}»` : '';
  const details = [numbers, stage].filter(Boolean).join('; ');
  return `${icon} ${notice.rule}${title ? ` ${title}` : ''}${details ? ` (${details})` : ''}${
    project ? ` — ${project}` : ''
  }`;
}

/** Отправитель сигналов сторожа: та же тишина без настройки, токена или чата. */
export function createGroupSignalTelegram(deps: TelegramDeps): (notice: GroupSignalNotice) => void {
  return (notice) => {
    const settings = deps.settings();
    if (!settings.enabled || !settings.chatId) return;
    const token = deps.token();
    if (!token) return;
    void sendTelegramMessage(token, settings.chatId, composeGroupSignal(notice)).catch(
      (error: unknown) => deps.onError?.(error),
    );
  };
}
