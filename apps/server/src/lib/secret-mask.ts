import { isSecretEnvKey } from '@agentdeck/contracts/env-secret';

/**
 * Где в тексте секрет — ОДИН детектор для всего, что видит агент панели: дифф
 * карточки, списки MCP/хуков/прав/правил, отказ в приёме секрета от модели и
 * маска реплик человека.
 *
 * Пока правило жило по месту (имя ключа JSON или `KEY=value`), оно пропускало
 * ровно те формы, которыми секреты лежат в настоящих конфигах: `--header
 * "Authorization: Bearer …"` у mcp-remote, заголовок `X-Auth`, пароль в
 * `postgres://u:pass@h`, `?apiKey=` в адресе и ключ без префикса вендора.
 * Ревью 17.09.2026 сняло каждый из них живым `list_mcp`.
 *
 * Модуль чистый: строка на вход, промежутки на выход. Ссылка `${VAR}` — не
 * секрет, а адрес секрета: она остаётся видна везде.
 */

export const SECRET_MASK = '••••••';

/** Промежуток значения секрета в исходной строке, `end` не включительно. */
export interface SecretSpan {
  start: number;
  end: number;
}

/** Прежнее правило подстрокой: оно уже маскировало дифф, сужать его нельзя. */
const LEGACY_NAME =
  /authorization|cookie|api[-_]?key|token|secret|password|passwd|bearer|credential/i;

/** Сегменты имени, которые сами по себе делают его секретом. */
const SECRET_SEGMENTS = new Set([
  'auth',
  'authorization',
  'token',
  'key',
  'apikey',
  'secret',
  'password',
  'passwd',
  'passphrase',
  'pass',
  'pwd',
  'pat',
  'credential',
  'credentials',
  'cookie',
  'bearer',
  'jwt',
  'sig',
  'signature',
  'пароль',
  'токен',
  'ключ',
]);

/** Хвосты склеенного сегмента: `accesstoken`, `xapikey`. Не `key` — иначе `hotkey`. */
const SECRET_SUFFIXES = ['token', 'secret', 'password', 'apikey'];

/**
 * Секретно ли имя поля, заголовка, переменной или флага. Сегменты режутся по
 * любому не-буквенному символу и по границе camelCase: `X-Auth`, `primaryApiKey`,
 * `access_token`, `--jira-token`. `MAX_THINKING_TOKENS` — не секрет по правилу
 * окружения, но прежнее подстрочное правило его маскировало, и так остаётся.
 */
export function isSecretName(name: string): boolean {
  if (isSecretEnvKey(name) || LEGACY_NAME.test(name)) return true;
  const segments = name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9а-яё]+/u)
    .filter(Boolean);
  return segments.some(
    (segment) =>
      SECRET_SEGMENTS.has(segment) ||
      /^auth(?:orization|token|key|header|[nz])$/.test(segment) ||
      SECRET_SUFFIXES.some((suffix) => segment.length > suffix.length && segment.endsWith(suffix)),
  );
}

const isReference = (value: string): boolean => /^\$\{[^}]+\}$/.test(value.trim());

/** Пусто или только ссылки `${VAR}` — значение без секрета. */
const REFERENCE_ONLY = /^(?:\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}\s*)+$/;
export const isSecretFree = (value: string): boolean =>
  value.trim() === '' || REFERENCE_ONLY.test(value.trim());

/**
 * Похоже ли значение само по себе на ключ, без подсказки именем: длина от 24,
 * буквы и цифры вперемешку (или hex от 32), разнообразие символов. Путь, адрес
 * и UUID сюда не попадают: символы `/ \ : .` рвут кандидата, а UUID — hex с
 * дефисами и одним регистром.
 */
export function looksLikeOpaqueToken(value: string): boolean {
  if (value.length < 24) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return false;
  const hasDigit = /[0-9]/.test(value);
  const hasLower = /[a-z]/.test(value);
  const hasUpper = /[A-Z]/.test(value);
  const hex = /^[0-9a-fA-F]{32,}$/.test(value);
  // Идентификатор кода (`useChatMessagesPlaceholderData2`) тоже пёстрый, но
  // цифр в нём одна-две; у ключа они рассыпаны по всей длине.
  const digits = value.replace(/[^0-9]/g, '').length;
  if (!hex && !(hasDigit && hasLower && hasUpper && digits >= 3)) return false;
  return shannon(value) >= 3.2;
}

function shannon(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * Похоже ли значение после слова «пароль» на пароль: без цифры или спецсимвола
 * это продолжение фразы («пароль от джиры»), а имя файла с точкой — не пароль.
 */
const looksLikePassword = (value: string): boolean =>
  value.length >= 6 &&
  /[0-9!@#$%^&*?+=~]/.test(value) &&
  !/^[\w-]+(?:\.[\w-]+)+$/.test(value) &&
  !isReference(value);

type Detector = (text: string, push: (start: number, end: number) => void) => void;

/** Значение группы `group` совпадения с флагом `d`. */
function groupSpan(match: RegExpExecArray, group: number): SecretSpan | undefined {
  const indices = match.indices?.[group];
  return indices ? { start: indices[0], end: indices[1] } : undefined;
}

function eachMatch(
  text: string,
  pattern: RegExp,
  onMatch: (match: RegExpExecArray) => SecretSpan | undefined,
  push: (start: number, end: number) => void,
): void {
  for (const match of text.matchAll(pattern)) {
    const span = onMatch(match as RegExpExecArray);
    if (span && span.end > span.start) push(span.start, span.end);
  }
}

const DETECTORS: Detector[] = [
  // "name": "value" — строка JSON с секретным ключом.
  (text, push) =>
    eachMatch(
      text,
      /"([^"\\]+)"\s*:\s*"((?:[^"\\]|\\.)*)"/dg,
      (match) =>
        match[2] && !isReference(match[2]) && match[2] !== SECRET_MASK && isSecretName(match[1]!)
          ? groupSpan(match, 2)
          : undefined,
      push,
    ),
  // `Authorization: Bearer x`, `X-Auth: x`, `password: x` — заголовок или пара в тексте.
  (text, push) =>
    eachMatch(
      text,
      /(?<![\w-])([A-Za-z][A-Za-z0-9_-]*)[ \t]*:[ \t]*(?:(?:Bearer|Basic|Token|Digest)[ \t]+)?([^\s"'`,;]+)/dg,
      (match) => {
        const name = match[1]!;
        const value = match[2]!;
        if (!isSecretName(name) || isReference(value) || value === SECRET_MASK) return undefined;
        // У заголовков доступа значение — всегда секрет; у прочих пар в прозе
        // («Primary key: id») — только значение, похожее на секрет.
        const header =
          /^(?:proxy-)?authorization$|^(?:set-)?cookie$|(?:^|[-_])auth(?:[-_]|$)|auth[-_]?token/i.test(
            name,
          );
        return header || looksLikePassword(value) || looksLikeOpaqueToken(value)
          ? groupSpan(match, 2)
          : undefined;
      },
      push,
    ),
  // `Bearer x` без имени заголовка.
  (text, push) =>
    eachMatch(
      text,
      /\b(?:Bearer|Basic)\s+(?!\$\{)([A-Za-z0-9._~+/=-]{6,})/dg,
      (match) => (match[1] === SECRET_MASK ? undefined : groupSpan(match, 1)),
      push,
    ),
  // `NAME=value`, `--api-key=value`, `?apiKey=value&` — пара с секретным именем.
  (text, push) =>
    eachMatch(
      text,
      /(?<![\w-])(-{0,2}[A-Za-z_][A-Za-z0-9_-]*)=([^\s"'`&#]+)/dg,
      (match) =>
        isSecretName(match[1]!.replace(/^-+/, '')) &&
        !isReference(match[2]!) &&
        match[2] !== SECRET_MASK
          ? groupSpan(match, 2)
          : undefined,
      push,
    ),
  // `--token value` одной строкой (команда хука).
  (text, push) =>
    eachMatch(
      text,
      /(?<![\w-])--?([A-Za-z][A-Za-z0-9_-]*)[ \t]+(?!-)([^\s"'`]+)/dg,
      (match) =>
        isSecretName(match[1]!) && !isReference(match[2]!) && match[2] !== SECRET_MASK
          ? groupSpan(match, 2)
          : undefined,
      push,
    ),
  // Пароль в адресе: `scheme://user:pass@host`, токен вместо логина `scheme://tok@host`.
  (text, push) =>
    eachMatch(
      text,
      /[A-Za-z][A-Za-z0-9+.-]*:\/\/([^\s/@:"'`]+)(?::([^\s/@"'`]*))?@/dg,
      (match) => {
        if (match[2] !== undefined) {
          return match[2] && match[2] !== SECRET_MASK && !isReference(match[2])
            ? groupSpan(match, 2)
            : undefined;
        }
        const user = match[1]!;
        return user !== SECRET_MASK && !isReference(user) && looksLikeOpaqueToken(user)
          ? groupSpan(match, 1)
          : undefined;
      },
      push,
    ),
  // «пароль от джиры Qwerty!2345», «password is hunter2!»: до трёх слов после слова.
  (text, push) =>
    eachMatch(
      text,
      /(?:парол[ьяеи]\p{L}*|password|passwd|passphrase)(?:[ \t]*[:=][ \t]*|[ \t]+(?:[^\s]+[ \t]+){0,3}?)((?=[^\s"'`,;]*[0-9!@#$%^&*?+=~])[^\s"'`,;]{6,})/dgiu,
      (match) => (looksLikePassword(match[1]!) ? groupSpan(match, 1) : undefined),
      push,
    ),
  // Ключи известных форм: префикс вендора или JWT.
  (text, push) =>
    eachMatch(
      text,
      /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,})/g,
      (match) => ({ start: match.index, end: match.index + match[0].length }),
      push,
    ),
  // Непрозрачный ключ без подсказки: длинная пёстрая строка.
  (text, push) =>
    eachMatch(
      text,
      /[A-Za-z0-9_+-]{24,}={0,2}/g,
      (match) => {
        const value = match[0].replace(/^[-_+]+|[-_+]+$/g, '');
        if (!looksLikeOpaqueToken(value)) return undefined;
        const start = match.index + match[0].indexOf(value);
        return { start, end: start + value.length };
      },
      push,
    ),
];

/** Все промежутки секретов в строке, слитые и по порядку. */
export function findSecretSpans(text: string): SecretSpan[] {
  const found: SecretSpan[] = [];
  for (const detect of DETECTORS) detect(text, (start, end) => found.push({ start, end }));
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: SecretSpan[] = [];
  for (const span of found) {
    const last = merged.at(-1);
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}

/** Строка с секретами, заменёнными меткой (`replace` получает само значение). */
export function replaceSecrets(text: string, replace: (value: string) => string): string {
  const spans = findSecretSpans(text);
  let out = text;
  for (let index = spans.length - 1; index >= 0; index -= 1) {
    const span = spans[index]!;
    out =
      out.slice(0, span.start) + replace(text.slice(span.start, span.end)) + out.slice(span.end);
  }
  return out;
}

/** Строка для глаз агента и карточки: значения секретов — `••••••`. */
export function maskSecretsInText(text: string): string {
  return replaceSecrets(text, () => SECRET_MASK);
}

/**
 * Значение с известным именем (переменная, заголовок): секретное имя прячет
 * значение целиком, иначе решает детектор по самому значению.
 */
export function maskNamedValue(name: string, value: string): string {
  if (isSecretFree(value)) return value;
  return isSecretName(name) ? SECRET_MASK : maskSecretsInText(value);
}

/** Аргументы команды: значение после секретного флага (`--token abc`) прячется целиком. */
export function maskArgList(args: readonly string[]): string[] {
  return args.map((arg, index) => {
    const flag = /^--?([A-Za-z0-9_-]+)$/.exec(args[index - 1] ?? '')?.[1];
    if (flag && isSecretName(flag) && !arg.startsWith('-') && !isSecretFree(arg)) {
      return SECRET_MASK;
    }
    return maskSecretsInText(arg);
  });
}
