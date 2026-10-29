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
 * буквы обоих регистров (или hex от 32), разнообразие символов. Путь, адрес
 * и UUID сюда не попадают: символы `/ \ : .` рвут кандидата, а UUID — hex с
 * дефисами и одним регистром.
 */
export function looksLikeOpaqueToken(value: string, minLength = 24): boolean {
  if (value.length < minLength) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return false;
  const hex = /^[0-9a-fA-F]{32,}$/.test(value);
  if (!hex) {
    if (!/[a-z]/.test(value) || !/[A-Z]/.test(value)) return false;
    // Идентификатор кода (`useChatMessagesPlaceholderData2`) тоже пёстрый. Раньше
    // его отличали только числом цифр (от трёх — ключ), и случайный ключ с одной-
    // двумя цифрами уходил открытым: из 32 знаков — каждый десятый, из 24 —
    // каждый четвёртый. Цифры ключ выдают, когда они есть; когда их мало, решает
    // форма слов (`looksLikeIdentifier`).
    const digits = value.replace(/[^0-9]/g, '').length;
    if (digits < 3 && looksLikeIdentifier(value)) return false;
  }
  return shannon(value) >= 3.2;
}

/**
 * Сложено ли значение из слов, как имя в коде: почти все буквы — в словах вида
 * `Word`/`word`, слова в среднем от четырёх букв, гласных не меньше пятой части.
 * У случайной строки заглавные идут подряд и через одну строчную, слова по одной-
 * двум буквам и гласных около пятой части — сразу все три условия она почти не
 * выполняет (замер 28.09: 12 утечек на 24 000 ключей против 2380, и ни одного
 * нового срабатывания на 1964 длинных именах из кода панели).
 */
function looksLikeIdentifier(value: string): boolean {
  const letters = value.replace(/[^A-Za-z]/g, '');
  const words = value.match(/[A-Z]?[a-z]+/g) ?? [];
  const inWords = words.reduce((sum, word) => sum + word.length, 0);
  const vowels = letters.replace(/[^aeiouyAEIOUY]/g, '').length;
  return (
    words.length > 0 &&
    inWords / letters.length >= 0.85 &&
    inWords / words.length >= 4 &&
    vowels / letters.length >= 0.2
  );
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

/** Настройка детектора для одного потребителя; по умолчанию — прежнее поведение. */
export interface MaskOptions {
  /**
   * Хэш коммита или содержимого (ровно 40 или 64 hex: SHA-1, SHA-256) БЕЗ секретного
   * имени рядом — не секрет. Для раннера ассистента (ревью F6, 28.09): маска прятала
   * от модели, о каком коммите речь. Hex под секретным именем (`GITHUB_TOKEN=…`)
   * ловят именные детекторы — это правило их не касается.
   */
  keepHashes?: boolean;
}

const isHash = (value: string): boolean => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value);

/** Префикс вендора или JWT: форма, которая ключ всегда, где бы ни стояла. */
const KNOWN_KEY =
  /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,})/g;

/**
 * Промежутки ключей известной формы. Отдельно от прочих: сетка перед моделью не
 * прощает их даже в сегменте пути (ревью U0, m1) — `C:\keys\sk-ant-…` остаётся ключом.
 */
export function knownKeySpans(text: string): SecretSpan[] {
  return [...text.matchAll(KNOWN_KEY)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
}

/**
 * Имя из слов через `-`/`_` со случайным хвостом (`cc-agent-gaps-walk-32tvF6`,
 * папка `mkdtemp`): пёстрым его делает склейка, а не ключ. Только эта форма —
 * все куски, кроме последнего, — слова (`agent`, `Walk`, `PROBE`), хвост не
 * длиннее 8: ключ с префиксом-словом и хвостом 16–23 знака (`live_Hf3Jg0Rs5Yu2…`)
 * или из двух половин остаётся ключом (ревью A и ревью сит, 28.09). Кусок из
 * букв вперемешку (`iiCllLmnfDlEQPPPQEQJ`) — не слово: так ключ base64url с
 * `-`/`_` внутри сходил за имя папки.
 */
function isWordsWithTail(value: string): boolean {
  const pieces = value.split(/[-_]+/);
  const tail = pieces.at(-1) ?? '';
  return (
    pieces.length >= 2 &&
    tail.length <= 8 &&
    pieces
      .slice(0, -1)
      .every((piece) => piece.length >= 2 && /^(?:[A-Z]?[a-z]+|[A-Z]+)$/.test(piece))
  );
}

/** Кандидат в base64: пёстрый, с `/` или `+`, без сегмента-слова пути. */
function looksLikeBase64(value: string): boolean {
  const body = value.replace(/=+$/, '');
  if (!/[+/]/.test(body) || body.startsWith('/') || body.endsWith('/') || body.includes('//')) {
    return false;
  }
  const pieces = body.split(/[+/]/);
  if (pieces.some((piece) => /^[a-z]{3,}$/.test(piece))) return false;
  return looksLikeOpaqueToken(pieces.join(''));
}

type Detector = (
  text: string,
  push: (start: number, end: number) => void,
  options: MaskOptions,
) => void;

/** Значение после секретного флага в списке аргументов — то же правило, что у `maskArgList`. */
const listedSecret = (flag: string, value: string): boolean =>
  isSecretName(flag) &&
  value !== '' &&
  !value.startsWith('-') &&
  value !== SECRET_MASK &&
  !isSecretFree(value);

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

/**
 * Значение секретной пары в кавычках: группа 2 — в двойных, 3 — в одинарных.
 * Кавычки в маску не входят — модель видит `NAME="••••••"`, и строка
 * возвращается слово в слово. Пусто или одни ссылки `${VAR}` — не секрет.
 */
function quotedValue(match: RegExpExecArray, name: string): SecretSpan | undefined {
  const at = match[2] !== undefined ? 2 : 3;
  const value = match[at] ?? '';
  if (!value.trim() || !isSecretName(name) || isSecretFree(value) || value === SECRET_MASK) {
    return undefined;
  }
  return groupSpan(match, at);
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
  // Значение секретной пары в кавычках — целиком, с пробелами, `#` и `&` (ревью F3,
  // 28.09): `password: "hunter two 2"` (YAML), `export API_TOKEN="tok en"`,
  // `--api-key "a b"` (`formatArgs` берёт в кавычки аргумент с пробелом). Правила без
  // кавычек выше останавливались на первой кавычке или пробеле и такое пропускали.
  // Отдельными проходами, а не альтернативой в правилах выше: совпадение в кавычках
  // «съело» бы текст, и секрет внутри чужой строки в кавычках правило бы не увидело.
  (text, push) =>
    eachMatch(
      text,
      /(?<![\w-])([A-Za-z][A-Za-z0-9_-]*)[ \t]*:[ \t]*(?:"([^"\n]*)"|'([^'\n]*)')/dg,
      (match) => quotedValue(match, match[1]!),
      push,
    ),
  (text, push) =>
    eachMatch(
      text,
      /(?<![\w-])(-{0,2}[A-Za-z_][A-Za-z0-9_-]*)=(?:"([^"\n]*)"|'([^'\n]*)')/dg,
      (match) => quotedValue(match, match[1]!.replace(/^-+/, '')),
      push,
    ),
  (text, push) =>
    eachMatch(
      text,
      /(?<![\w-])--?([A-Za-z][A-Za-z0-9_-]*)[ \t]+(?:"([^"\n]*)"|'([^'\n]*)')/dg,
      (match) => quotedValue(match, match[1]!),
      push,
    ),
  // Пара целиком в кавычках: `"--db-password=pa ss 9"`, `'API_TOKEN=tok en'` —
  // значение до закрывающей кавычки.
  (text, push) =>
    eachMatch(
      text,
      /(["'])(-{0,2}[A-Za-z_][A-Za-z0-9_-]*)=([^"'\n]*)\1/dg,
      (match) => {
        const value = match[3]!;
        return value.trim() &&
          isSecretName(match[2]!.replace(/^-+/, '')) &&
          !isSecretFree(value) &&
          value !== SECRET_MASK
          ? groupSpan(match, 3)
          : undefined;
      },
      push,
    ),
  // Аргументы списком (U0, 28.09.2026, прогон всех действий агента): флаг и значение —
  // соседние элементы массива, а не одна строка. `"--api-key", "x"` у JSON и TOML
  // (`args = [ … ]`), в том числе на соседних строках диффа с маркером `-`/`+`/` `.
  (text, push) =>
    eachMatch(
      text,
      /(["'])--?([A-Za-z][A-Za-z0-9_-]*)\1[ \t]*,[ \t]*(?:\r?\n[-+ ]?[ \t]*)?(["'])((?:(?!\3)[^\\\r\n]|\\.)*)\3/dg,
      (match) => (listedSecret(match[2]!, match[4]!) ? groupSpan(match, 4) : undefined),
      push,
    ),
  // …и YAML (`args:` у goose/continue): `- --api-key` и значение следующим пунктом.
  (text, push) =>
    eachMatch(
      text,
      /(?<![\w-])-[ \t]+(["']?)--?([A-Za-z][A-Za-z0-9_-]*)\1[ \t]*\r?\n[-+ ]?[ \t]*-[ \t]+(["']?)([^\s"'`#]+)\3/dg,
      (match) => (listedSecret(match[2]!, match[4]!) ? groupSpan(match, 4) : undefined),
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
  (text, push) => knownKeySpans(text).forEach((span) => push(span.start, span.end)),
  // Стандартный base64 (ревью U0, m3, 28.09.2026): `/` и `+` внутри, `=`/`==` в конце —
  // один токен от 32. Класс кандидата ниже рвал его на `/` на куски короче порога.
  // Путь сюда не попадает: токен не начинается после `/ \ . : @ % ~`, не начинается
  // и не кончается `/`, и в нём нет сегмента-слова (`src/lib/…`).
  (text, push) =>
    eachMatch(
      text,
      /(?<![A-Za-z0-9+/_\-.\\:@%~])[A-Za-z0-9+/]{32,}={0,2}(?![A-Za-z0-9+/_\-.\\:@%~=])/g,
      (match) =>
        looksLikeBase64(match[0])
          ? { start: match.index, end: match.index + match[0].length }
          : undefined,
      push,
    ),
  // Непрозрачный ключ без подсказки: длинная пёстрая строка.
  (text, push, options) =>
    eachMatch(
      text,
      /[A-Za-z0-9_+-]{24,}={0,2}/g,
      (match) => {
        const value = match[0].replace(/^[-_+]+|[-_+]+$/g, '');
        // Края `-`/`_` срезаются, но длину кандидата задаёт совпадение целиком: ключ
        // base64url из 24 знаков с `-` на краю иначе становился 23-значным и уходил
        // открытым — каждый четырнадцатый такой ключ (замер 28.09).
        const minLength = match[0].length >= 24 ? 20 : 24;
        if (!looksLikeOpaqueToken(value, minLength) || isWordsWithTail(value)) return undefined;
        if (options.keepHashes && isHash(value)) return undefined;
        const start = match.index + match[0].indexOf(value);
        return { start, end: start + value.length };
      },
      push,
    ),
];

/** Все промежутки секретов в строке, слитые и по порядку. */
export function findSecretSpans(text: string, options: MaskOptions = {}): SecretSpan[] {
  const found: SecretSpan[] = [];
  for (const detect of DETECTORS) detect(text, (start, end) => found.push({ start, end }), options);
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
export function replaceSecrets(
  text: string,
  replace: (value: string) => string,
  options: MaskOptions = {},
): string {
  const spans = findSecretSpans(text, options);
  let out = text;
  for (let index = spans.length - 1; index >= 0; index -= 1) {
    const span = spans[index]!;
    out =
      out.slice(0, span.start) + replace(text.slice(span.start, span.end)) + out.slice(span.end);
  }
  return out;
}

/** Строка для глаз агента и карточки: значения секретов — `••••••`. */
export function maskSecretsInText(text: string, options: MaskOptions = {}): string {
  return replaceSecrets(text, () => SECRET_MASK, options);
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

/**
 * Что стоит за каждой маской в `maskSecretsInText(saved)`, по порядку: значение
 * секрета или сама маска, если она уже была в тексте буквально.
 */
function maskedValues(saved: string, options: MaskOptions): string[] {
  const values: string[] = [];
  const literal = (part: string): void => {
    for (let count = part.split(SECRET_MASK).length - 1; count > 0; count -= 1) {
      values.push(SECRET_MASK);
    }
  };
  let at = 0;
  for (const span of findSecretSpans(saved, options)) {
    literal(saved.slice(at, span.start));
    values.push(saved.slice(span.start, span.end));
    at = span.end;
  }
  literal(saved.slice(at));
  return values;
}

/**
 * Вернуть секреты, которые модель видела маской и прислала обратно.
 *
 * Агенту панели текст уходит через `maskSecretsInText`, и правка «прочитал —
 * поменял — сохранил» приносит `••••••` на место каждого секрета. Записать так —
 * молча стереть секреты: карточка маскирует обе стороны diff и разницы не покажет.
 * Маска возвращается только в строке, слово в слово равной прочитанной: строку
 * можно переставить или оставить, но не переписать. По одному номеру маски
 * модель уносила секрет в новый контекст (`curl https://чужой/?k=••••••`, другой
 * хост адреса, соседнее имя), а карточка прячет обе стороны и подмены не видно.
 * Масок должно быть ровно столько же; не сходится — `undefined`, запись
 * отказывается, а не угадывает.
 */
export function restoreMaskedSecrets(
  saved: string,
  sent: string,
  options: MaskOptions = {},
): string | undefined {
  if (!sent.includes(SECRET_MASK)) return sent;
  const values = maskedValues(saved, options);
  if (values.length !== sent.split(SECRET_MASK).length - 1) return undefined;
  // Строки прочитанного текста с масками: сама строка, ближайшая строка без
  // маски над ней (контекст) и значения её масок.
  const entries: MaskedLine[] = [];
  let next = 0;
  let context = '';
  for (const line of maskSecretsInText(saved, options).split('\n')) {
    const count = line.split(SECRET_MASK).length - 1;
    if (count === 0) {
      context = line;
      continue;
    }
    entries.push({ line, context, values: values.slice(next, next + count), used: false });
    next += count;
  }
  if (next !== values.length) return undefined;
  const out: string[] = [];
  context = '';
  for (const line of sent.split('\n')) {
    const parts = line.split(SECRET_MASK);
    if (parts.length === 1) {
      out.push(line);
      context = line;
      continue;
    }
    const own = ownValues(entries, line, context);
    if (!own) return undefined;
    out.push(parts.reduce((text, part, index) => text + own[index - 1]! + part));
  }
  return out.join('\n');
}

interface MaskedLine {
  line: string;
  context: string;
  values: string[];
  used: boolean;
}

/**
 * Значения для строки с маской. Одинаковых строк бывает несколько (`"token": "••••••"`
 * у двух серверов): очередь по порядку отдавала секрет A блоку B, стоило модели
 * переставить блоки. Одинаковые значения — берётся любое; разные — решает строка
 * без маски над ней (адрес своего сервера); не решает и она — отказ, а не угадывание.
 */
function ownValues(entries: MaskedLine[], line: string, context: string): string[] | undefined {
  const same = (list: MaskedLine[]): boolean =>
    list.every((entry) => entry.values.join('\n') === list[0]!.values.join('\n'));
  const free = entries.filter((entry) => !entry.used && entry.line === line);
  let pick = free.length > 0 && same(free) ? free[0] : undefined;
  if (!pick) {
    const near = free.filter((entry) => entry.context === context);
    pick = near.length > 0 && same(near) ? near[0] : undefined;
  }
  if (!pick) return undefined;
  pick.used = true;
  return pick.values;
}
