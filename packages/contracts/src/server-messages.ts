import { serverMessageAreas, serverMessageParams } from './server-messages/table.ts';

/**
 * Человеческие тексты сервера — кодом, а не только русской строкой.
 *
 * Сервер пишет причины по-русски (решение владельца: второй язык в сервере не
 * держим), и английский интерфейс показывал их как есть. Поэтому рядом с
 * прежним текстом (`detail` / `message` — он остаётся запасным для старых
 * записей и для клиентов, которые кода не знают) сервер кладёт стабильный код и
 * подстановки, а панель и телефон переводят код своими словарями.
 *
 * Поле названо `messageCode`, а не `code`: у отказов `code` давно занят ВИДОМ
 * отказа (`platform_not_found`, `run_busy`), по которому клиенты принимают
 * решения, — а текст у одного вида бывает разный.
 *
 * Модуль без zod и без пакетов (только свои области рядом): его значения нужны
 * серверу (он грузит контракты без сборки) и телефону (у Metro нет zod).
 */

/**
 * Код → имена подстановок. Список подстановок — часть контракта: тест словарей
 * сверяет, что перевод использует ровно их, и забытое `{{title}}` краснеет в
 * тесте, а не на экране пустым местом. Сама таблица разложена по областям
 * (`server-messages/<область>.ts`) и собрана в `server-messages/table.ts`.
 */
export { serverMessageAreas, serverMessageParams };
export type * from './server-messages/table.ts';

export type ServerMessageCode = keyof typeof serverMessageParams;

export const serverMessageCodes = Object.keys(serverMessageParams) as ServerMessageCode[];

export type ServerMessageParams = Record<string, string | number>;

export function isServerMessageCode(value: unknown): value is ServerMessageCode {
  return (
    typeof value === 'string' && Object.prototype.hasOwnProperty.call(serverMessageParams, value)
  );
}

/** Подстановки в тексте словаря — те же `{{имя}}`, что у i18next в панели. */
export function templateParams(template: string): string[] {
  return [...template.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((match) => match[1] as string);
}

/**
 * Текст по шаблону словаря. Панель переводит через i18next, телефон — этим:
 * недостающая подстановка остаётся пустой строкой, а не `{{name}}` на экране.
 */
export function formatServerMessage(template: string, params: ServerMessageParams = {}): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) =>
    params[name] === undefined ? '' : String(params[name]),
  );
}

/**
 * Код текста рядом с русской строкой в записи или отказе: `message`/`error` →
 * `messageCode` + `params`. Для других полей код зовётся по полю
 * (`detailCode` + `detailParams`, `reasonCode` + `reasonParams`…).
 */
export interface CodedMessage {
  messageCode?: ServerMessageCode;
  params?: ServerMessageParams;
}

/**
 * Код и подстановки рядом с текстовым полем записи: `detail` + `detailCode` +
 * `detailParams`. Поля необязательные: сервер вешает код там, где узнал свою же
 * строку, а старая запись из `state.json` приезжает без кода — тогда клиент
 * показывает русский текст поля.
 */
export type CodedFields<F extends string> = {
  [K in `${F}Code`]?: ServerMessageCode;
} & {
  [K in `${F}Params`]?: ServerMessageNestedParams;
};

/**
 * Коды строк списка: `warnings` → `warningsCodes` той же длины, `null` на месте
 * строки, которую сервер шаблоном не прочитал. Список переводится по индексу,
 * поэтому массив кодов никогда не короче самого списка.
 */
export type CodedList<F extends string> = {
  [K in `${F}Codes`]?: (NestedServerMessage | null)[];
};

/**
 * Подстановка, которая сама — текст сервера. Так приходят причины, собранные из
 * чужой фразы и своей («Нет связи с контуром: …» внутри шага пробы): сервер
 * разбирает готовую строку и кладёт вложенный код, чтобы клиент перевёл и его.
 */
export interface NestedServerMessage {
  messageCode: ServerMessageCode;
  params?: ServerMessageNestedParams;
}

export type ServerMessageNestedParams = Record<
  string,
  string | number | NestedServerMessage | undefined
>;

/**
 * Подстановки-моменты: сервер шлёт момент ISO, а часы из него собирает
 * КЛИЕНТ — по поясу того, кто смотрит. Панель и телефон бывают в разных поясах
 * (доступ через Tailscale), и «лимит до 14:00» по часам сервера читалось бы
 * как чужое время.
 */
export const CLOCK_PARAMS: ReadonlySet<string> = new Set(['until']);

/** Момент ISO → «ЧЧ:ММ» в поясе этого процесса; не момент — как есть. */
export function localClock(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/**
 * Вложенные подстановки → плоские, каждая уже переведённая. `undefined` —
 * вложенный код клиенту неизвестен (сервер новее): тогда переводить нечего и
 * показывается русская строка поля целиком, а не фраза с дырой посередине.
 */
export function resolveServerParams(
  params: unknown,
  render: (code: ServerMessageCode, params?: ServerMessageParams) => string | undefined,
): ServerMessageParams | undefined {
  if (typeof params !== 'object' || params === null) return {};
  const out: ServerMessageParams = {};
  for (const [name, value] of Object.entries(params as Record<string, unknown>)) {
    if (typeof value === 'string' || typeof value === 'number') {
      out[name] = typeof value === 'string' && CLOCK_PARAMS.has(name) ? localClock(value) : value;
      continue;
    }
    if (typeof value !== 'object' || value === null) continue;
    const nested = value as { messageCode?: unknown; params?: unknown };
    if (!isServerMessageCode(nested.messageCode)) return undefined;
    const inner = resolveServerParams(nested.params, render);
    if (!inner) return undefined;
    const text = render(nested.messageCode, inner);
    if (text === undefined) return undefined;
    out[name] = text;
  }
  return out;
}
