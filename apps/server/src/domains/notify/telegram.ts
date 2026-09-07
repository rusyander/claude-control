import { basename } from 'node:path';
import type { TelegramEvent, TelegramSettings } from '@agentdeck/contracts';
import type { RunNotice } from '../chat/ChatRunRegistry.ts';
import { describeFailure, parseJson, sendRequest } from '../integrations/http.ts';
import { unreachable } from '../integrations/errors.ts';

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

const API = 'https://api.telegram.org';
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

export type TelegramNotice = RunNotice | TestFailedNotice;

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
    url: `${API}/bot${token}/sendMessage`,
    // Токен бота — ЧАСТЬ АДРЕСА. Без этой подписи он уехал бы в подробность
    // отказа, а оттуда в ответ API и в журнал панели.
    label: `${API}/bot<токен>/sendMessage`,
    method: 'POST',
    system: SYSTEM,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  if (!response.ok) {
    throw unreachable(safeDetail(describeFailure(SYSTEM, response)), safeDetail(response.text));
  }
}

/**
 * Кто мы для Telegram: имя бота. Это и есть проверка связи — `getMe` ничего не
 * шлёт в чат, поэтому кнопку «Проверить» можно жать сколько угодно.
 */
export async function telegramMe(token: string): Promise<string> {
  const response = await sendRequest({
    url: `${API}/bot${token}/getMe`,
    label: `${API}/bot<токен>/getMe`,
    system: SYSTEM,
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw unreachable(safeDetail(describeFailure(SYSTEM, response)), safeDetail(response.text));
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
function safeDetail(text: string): string {
  return text.replace(/bot\d+:[\w-]+/g, 'bot<токен>').slice(0, 300);
}
