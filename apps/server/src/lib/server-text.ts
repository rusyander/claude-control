import { STATUS_CODES } from 'node:http';
import { matchText } from './server-texts.ts';
import type { FastifyInstance } from 'fastify';
import {
  isServerMessageCode,
  type ServerMessageCode,
  type ServerMessageParams,
} from '@agentdeck/contracts/server-messages';

/**
 * Код человеческого текста рядом с русской строкой (`contracts/server-messages.ts`).
 *
 * Сервер пишет по-русски, клиент переводит код своим словарём, а строка остаётся
 * запасной — для старых записей и клиентов, которые кода не знают. Здесь два
 * способа донести код до ответа, не переписывая каждый класс ошибки:
 * `coded(error, …)` вешает код на брошенную ошибку, `codeOf(error)` снимает его
 * там, где маршрут превращает ошибку в тело ответа.
 */
export interface CodedText {
  messageCode: ServerMessageCode;
  params?: ServerMessageParams;
}

/** Та же ошибка (или объект) с кодом текста. Возвращает свой аргумент — удобно в `throw`. */
export function coded<T extends object>(
  target: T,
  messageCode: ServerMessageCode,
  params?: ServerMessageParams,
): T & CodedText {
  return Object.assign(target, params ? { messageCode, params } : { messageCode });
}

/**
 * Код, прочитанный из записи (`messageCode` файла, группы, черновика): он
 * мог прийти от старой версии панели, поэтому незнакомый просто не вешается.
 */
export function codedIf<T extends object>(
  target: T,
  messageCode: string | undefined,
  params?: ServerMessageParams,
): T {
  return isServerMessageCode(messageCode) ? coded(target, messageCode, params) : target;
}

/**
 * Код текста у ошибки для тела ответа: `{ messageCode, params }` или пусто.
 * Незнакомое значение не пропускается — клиент получил бы код, которого нет в
 * его словаре, и показал бы пустоту вместо русской строки.
 */
export function codeOf(value: unknown): Partial<CodedText> {
  if (typeof value !== 'object' || value === null) return {};
  const { messageCode, params, message } = value as {
    messageCode?: unknown;
    params?: unknown;
    message?: unknown;
  };
  // Кода рядом нет — читаем его из самой строки: текст, написанный `serverText`
  // по коду, узнаётся шаблоном обратно, и маршруту не нужно вешать код руками.
  // Чужая строка шаблоном не читается и кода не получает.
  if (!isServerMessageCode(messageCode))
    return typeof message === 'string' ? matchedCode(message) : {};
  return typeof params === 'object' && params !== null
    ? { messageCode, params: params as ServerMessageParams }
    : { messageCode };
}

/**
 * Код, прочитанный из готовой строки: `serverText` пишет текст ПО коду, и разбор
 * возвращает код обратно вместе с подстановками. Чужая строка шаблоном не
 * читается и кода не получает.
 */
function matchedCode(text: string): Partial<CodedText> {
  const matched = matchText(text);
  if (!matched) return {};
  return matched.params
    ? { messageCode: matched.messageCode, params: matched.params as ServerMessageParams }
    : { messageCode: matched.messageCode };
}

/**
 * Тело отказа из ошибки: её текст и, если есть, код.
 *
 * Кода нет — пробуем прочитать его из самой строки: причины, собранные
 * `serverText` (`lib/server-texts.ts`), кода рядом не несут, он восстанавливается
 * разбором. Чужая строка шаблоном не читается и остаётся без кода.
 */
export function errorBody(error: unknown, field: 'message' | 'error' = 'message') {
  const text = error instanceof Error ? error.message : String(error);
  const explicit = codeOf(error);
  return { [field]: text, ...(explicit.messageCode ? explicit : matchedCode(text)) } as {
    message?: string;
    error?: string;
  } & Partial<CodedText>;
}

/**
 * Код текста и у ошибки, которую маршрут не поймал.
 *
 * Многие доменные ошибки несут `statusCode`, и Fastify отдаёт их сам — своим
 * сериализатором, который знает только `statusCode/code/error/message` и молча
 * выбросил бы `messageCode`. Здесь ошибка С кодом отдаётся той же формой плюс
 * код; ошибка без кода пробрасывается дальше — к обработчику Fastify по
 * умолчанию, так что прежний ответ (и журнал 5xx) не меняется ни на байт.
 */
export function registerCodedErrors(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const message = error instanceof Error ? error.message : String(error);
    const explicit = codeOf(error);
    const coded = explicit.messageCode ? explicit : matchedCode(message);
    if (!coded.messageCode) throw error;
    const raw = (error as { statusCode?: unknown }).statusCode;
    const statusCode = typeof raw === 'number' && raw >= 400 && raw < 600 ? raw : 500;
    if (statusCode >= 500) request.log.error(error);
    const { code } = error as { code?: unknown };
    return reply.code(statusCode).send({
      statusCode,
      ...(typeof code === 'string' ? { code } : {}),
      error: STATUS_CODES[statusCode],
      message,
      ...coded,
    });
  });
}
