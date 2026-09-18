import type { ServerMessageCode } from '@agentdeck/contracts/server-messages';
import { serverTextTemplates } from './server-texts/templates.ts';

/**
 * Тексты, которые сервер собирает СТРОКОЙ и отдаёт дальше строкой.
 *
 * Обычный путь кода (`coded`, `detailCode`) требует, чтобы код доехал рядом с
 * текстом. Здесь так не выходит: причина шлюза уезжает в CLI телом ошибки
 * вендорного диалекта (CLI печатает `error.message` как есть, клиента-переводчика
 * между ними нет), причина транспорта вкладывается в чужую фразу
 * («Нет связи с контуром: …» внутри шага пробы), а промежуточные слои держат её
 * полем `message: string`. Протянуть код через все эти слои — значит переписать
 * их типы ради перевода.
 *
 * Поэтому текст пишется ПО КОДУ (`serverText('gateway-…')`, шаблоны — в
 * `server-texts/templates.ts`, генерируется из того же манифеста, что и словари
 * клиентов), а код восстанавливается по готовой строке там, где она уходит
 * человеку: `matchText` для полей ответа панели (клиент переводит код своим
 * словарём), `localizeText` для тела, которое прочитает CLI (язык берётся из
 * настроек панели). Разбор однозначен, пока шаблоны различимы, — это сверяет
 * `server-texts.test.ts` на каждом шаблоне.
 */

export type ServerTextCode = keyof typeof serverTextTemplates & ServerMessageCode;
export type TextLanguage = 'ru' | 'en';
export type TextParams = Record<string, string | number>;

/** Разобранный текст: код и подстановки; подстановка сама бывает разобранным текстом. */
export interface MatchedText {
  messageCode: ServerTextCode;
  params?: Record<string, string | number | MatchedText>;
}

const PARAM = /\{\{\s*(\w+)\s*\}\}/g;

function fill(template: string, params: TextParams = {}): string {
  return template.replace(PARAM, (_, name: string) =>
    params[name] === undefined ? '' : String(params[name]),
  );
}

/** Русский текст по коду — тот, что сервер писал литералом до кодов. */
export function serverText(code: ServerTextCode, params?: TextParams): string {
  return fill(serverTextTemplates[code].ru, params);
}

interface Compiled {
  code: ServerTextCode;
  names: string[];
  pattern: RegExp;
  /**
   * Своего содержимого в шаблоне нет вовсе (`{{message}}: {{detail}}`) — это
   * склейка. Цифры считаются содержимым: « (401).» разбирается обычным
   * образом, и разрез искать не нужно.
   */
  joiner: boolean;
  weight: number;
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const COMPILED: Compiled[] = (Object.keys(serverTextTemplates) as ServerTextCode[])
  .map((code) => {
    const ru = serverTextTemplates[code].ru;
    const names = [...ru.matchAll(PARAM)].map((match) => match[1] as string);
    const literal = ru.replace(PARAM, '');
    const parts = ru.split(PARAM);
    // `split` с группой чередует литерал и имя: чётные — литералы.
    const source = parts
      .map((part, index) => (index % 2 === 0 ? escape(part) : '([\\s\\S]+?)'))
      .join('');
    return {
      code,
      names,
      pattern: new RegExp(`^${source}$`),
      joiner: !/[\p{L}\p{N}]/u.test(literal),
      weight: literal.length,
    };
  })
  // Длиннее литерал — строже шаблон: он пробуется первым.
  .sort((left, right) => right.weight - left.weight);

/**
 * Разбор зовётся на каждое текстовое поле карточки контура, а шаблонов сотни.
 * Две дешёвые отсечки до перебора: строка без кириллицы шаблоном быть не может
 * (все русские тексты её содержат, склейка — через известную голову), и один и
 * тот же текст (строки матрицы правил, подписи манифеста) разбирается один раз.
 */
const CYRILLIC = /[А-Яа-яЁё]/;
const MEMO = new Map<string, MatchedText | undefined>();
const MEMO_LIMIT = 500;
/**
 * Шаблоны без единой русской буквы в своей части («AgentDeck: {{message}}»,
 * «{{message}} (401).»): строка без кириллицы может быть только такой, и
 * перебирать ради неё сотни русских шаблонов незачем.
 */
const LATIN = COMPILED.filter((entry) => !CYRILLIC.test(serverTextTemplates[entry.code].ru));

export function matchText(value: string): MatchedText | undefined {
  if (MEMO.has(value)) return MEMO.get(value);
  const found = search(value, CYRILLIC.test(value) ? COMPILED : LATIN);
  if (MEMO.size >= MEMO_LIMIT) MEMO.clear();
  MEMO.set(value, found);
  return found;
}

/**
 * Код по готовой строке. Подстановка, которая сама читается известным шаблоном,
 * становится вложенным разбором — клиент переведёт и её. Склейка без букв
 * принимается, только если её первая часть — известный текст: иначе любое
 * «a: b» из чужого ответа получило бы код.
 */
function search(value: string, compiled: Compiled[]): MatchedText | undefined {
  for (const entry of compiled) {
    const found = entry.joiner ? matchJoiner(entry, value) : matchPattern(entry, value);
    if (found) return found;
  }
  return undefined;
}

function nested(raw: string): string | MatchedText {
  return matchText(raw) ?? raw;
}

function build(entry: Compiled, values: string[]): MatchedText {
  if (entry.names.length === 0) return { messageCode: entry.code };
  const params: Record<string, string | number | MatchedText> = {};
  entry.names.forEach((name, index) => {
    params[name] = nested(values[index] ?? '');
  });
  return { messageCode: entry.code, params };
}

function matchPattern(entry: Compiled, value: string): MatchedText | undefined {
  const match = entry.pattern.exec(value);
  return match ? build(entry, match.slice(1)) : undefined;
}

/** Склейка `{{a}}<разделитель>{{b}}`: ищется такой разрез, где голова — известный текст. */
function matchJoiner(entry: Compiled, value: string): MatchedText | undefined {
  const separator = serverTextTemplates[entry.code].ru.split(PARAM)[2] ?? '';
  if (entry.names.length !== 2 || !separator) return undefined;
  for (let at = value.indexOf(separator); at > 0; at = value.indexOf(separator, at + 1)) {
    const head = matchText(value.slice(0, at));
    const tail = value.slice(at + separator.length);
    if (head && tail) {
      return {
        messageCode: entry.code,
        params: { [entry.names[0] as string]: head, [entry.names[1] as string]: nested(tail) },
      };
    }
  }
  return undefined;
}

function render(matched: MatchedText, language: TextLanguage): string {
  const params: TextParams = {};
  for (const [name, value] of Object.entries(matched.params ?? {})) {
    params[name] = typeof value === 'object' ? render(value, language) : value;
  }
  return fill(serverTextTemplates[matched.messageCode][language], params);
}

/**
 * Строка на языке панели. Русский — как есть (сервер пишет по-русски); английский
 * — по разобранному коду. Незнакомая строка (слова самого контура) не трогается.
 */
export function localizeText(value: string, language: TextLanguage): string {
  if (language === 'ru') return value;
  const matched = matchText(value);
  return matched ? render(matched, language) : value;
}

/** Поле-текст → где лежит его код: у `message`/`error` — общие `messageCode` + `params`. */
function codeKeys(field: string): [string, string] {
  return field === 'message' || field === 'error'
    ? ['messageCode', 'params']
    : [`${field}Code`, `${field}Params`];
}

const TEXT_FIELDS = [
  'message',
  'error',
  'detail',
  'reason',
  'hint',
  'note',
  'title',
  'label',
  'where',
  // «Значение правила словами» матрицы контура: слово из закрытого набора или
  // список имён инструментов — второй шаблоном не читается и кода не получает.
  'value',
  'summary',
  'warning',
  'description',
] as const;

/**
 * Код к каждому текстовому полю ответа, если строка разбирается шаблоном.
 * Обходит объект вглубь и возвращает копию; поле, у которого код уже есть, не
 * трогает. Массив строк (`notes`) получает рядом `<поле>Codes` той же длины.
 */
export function attachTextCodes<T>(value: T, arrays: readonly string[] = []): T {
  if (Array.isArray(value)) return value.map((item) => attachTextCodes(item, arrays)) as T;
  if (typeof value !== 'object' || value === null) return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) out[key] = attachTextCodes(item, arrays);
  for (const field of TEXT_FIELDS) {
    const raw = source[field];
    if (typeof raw !== 'string') continue;
    const [codeKey, paramsKey] = codeKeys(field);
    if (source[codeKey] !== undefined) continue;
    const matched = matchText(raw);
    if (!matched) continue;
    out[codeKey] = matched.messageCode;
    if (matched.params) out[paramsKey] = matched.params;
  }
  for (const field of arrays) {
    const list = source[field];
    if (!Array.isArray(list) || source[`${field}Codes`] !== undefined) continue;
    const codes = list.map((item) => (typeof item === 'string' ? (matchText(item) ?? null) : null));
    if (codes.some((item) => item !== null)) out[`${field}Codes`] = codes;
  }
  return out as T;
}
