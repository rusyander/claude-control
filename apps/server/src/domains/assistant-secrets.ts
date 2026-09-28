import { isDeepStrictEqual } from 'node:util';
import {
  SECRET_MASK,
  isSecretFree,
  isSecretName,
  maskArgList,
  maskNamedValue,
  maskSecretsInText,
  restoreMaskedSecrets,
} from '../lib/secret-mask.ts';

/**
 * Секреты формы и помощник (U6 F3, 28.09): модель видит маску, форма получает
 * обратно свои значения.
 *
 * До правки поля формы уходили в задание как есть: форма MCP-сервера грузит
 * переменные и заголовки без маски, форма переменной — набранное значение. Они
 * попадали и в модель, и в транскрипт CLI.
 *
 * Детектор — общий с агентом панели (`lib/secret-mask.ts`), своего нет: два
 * детектора разошлись бы первым же новым видом секрета.
 */

/**
 * Имена полей верхнего уровня — это имена полей ФОРМЫ (`key`, `value`,
 * `envText`), а не имена секретов: `key` — имя переменной, и имя-секрет его
 * спрятало бы целиком. Поэтому наверху решает детектор по тексту, а имя
 * работает только парой «переменная — значение» (`key` + `value` формы
 * переменной) и во вложенных объектах, где ключ и есть имя заголовка/переменной.
 */
/**
 * Поля-строки «по паре на строку»: переменные (`envText`) и заголовки
 * (`headersText`). Форма хранит хвост строки после `=` целиком (`textToEnv`), и
 * значение с пробелом, `#`, `&` или в кавычках — настоящее; детектор по тексту
 * резал его на первом таком символе (ревью F3, 28.09). Здесь имя — начало строки.
 */
const LINE_PAIR_FIELDS = /(?:^|[a-z])(?:env|headers?)Text$/i;

const unquote = (value: string): string =>
  /^(["']).*\1$/s.test(value.trim()) ? value.trim().slice(1, -1) : value;

function maskPairLines(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const pair = /^(\s*(?:export\s+)?)([A-Za-z_][\w.-]*)(\s*[=:]\s*)(.*)$/.exec(line);
      if (!pair || !isSecretName(pair[2]!)) return maskSecretsInText(line);
      const value = pair[4]!;
      if (isSecretFree(unquote(value)) || unquote(value) === SECRET_MASK) return line;
      return `${pair[1]}${pair[2]}${pair[3]}${SECRET_MASK}`;
    })
    .join('\n');
}

/**
 * Аргументы строкой, как их пишет форма (`formatArgs`: аргумент с пробелом — в
 * кавычках). Значение после секретного флага и `--flag=значение` прячутся целиком,
 * вместе с кавычками; прочее — детектором по тексту. Разделители между
 * аргументами остаются как были.
 */
function maskArgsText(text: string): string {
  let out = '';
  let at = 0;
  let afterSecretFlag = false;
  for (const token of text.matchAll(/"[^"]*"|'[^']*'|\S+/g)) {
    const raw = token[0];
    const value = /^(["']).*\1$/s.test(raw) ? raw.slice(1, -1) : raw;
    const joined = /^(--?[A-Za-z0-9_-]+)=(.*)$/s.exec(value);
    let masked = maskSecretsInText(raw);
    if (afterSecretFlag && !value.startsWith('-') && !isSecretFree(value)) masked = SECRET_MASK;
    else if (joined && isSecretName(joined[1]!.replace(/^-+/, '')) && !isSecretFree(joined[2]!)) {
      masked = `${joined[1]}=${SECRET_MASK}`;
    }
    out += text.slice(at, token.index) + masked;
    at = token.index + raw.length;
    const flag = /^--?([A-Za-z0-9_-]+)$/.exec(value)?.[1];
    afterSecretFlag = Boolean(flag && isSecretName(flag));
  }
  return out + text.slice(at);
}

function maskValue(value: unknown, name: string | undefined, field?: string): unknown {
  if (typeof value === 'string' && field !== undefined) {
    if (LINE_PAIR_FIELDS.test(field)) return maskPairLines(value);
    if (field === 'args') return maskArgsText(value);
  }
  if (Array.isArray(value) && field === 'args' && value.every((item) => typeof item === 'string')) {
    return maskArgList(value as string[]);
  }
  if (typeof value === 'string') {
    return name === undefined ? maskSecretsInText(value) : maskNamedValue(name, value);
  }
  if (Array.isArray(value)) return value.map((item) => maskValue(item, name));
  if (value !== null && typeof value === 'object') {
    return maskObject(value as Record<string, unknown>, true);
  }
  return value;
}

function maskObject(fields: Record<string, unknown>, named: boolean): Record<string, unknown> {
  const pairName = typeof fields.key === 'string' ? fields.key : undefined;
  const out: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(fields)) {
    if (field === 'value' && pairName !== undefined && typeof value === 'string') {
      out[field] = maskNamedValue(pairName, value);
    } else if (field === 'key' && pairName !== undefined) {
      // Имя переменной — не секрет; значение секрета в имени ловит детектор.
      out[field] = maskSecretsInText(pairName);
    } else {
      out[field] = maskValue(value, named ? field : undefined, field);
    }
  }
  return out;
}

/** Поля формы для задания модели: значения секретов — `••••••`. */
export function maskFormFields(fields: Record<string, unknown>): Record<string, unknown> {
  return maskObject(fields, false);
}

/** Текст человека (просьба, реплика истории) для модели. */
export function maskAssistText(text: string): string {
  return maskSecretsInText(text);
}

const hasMask = (value: unknown): boolean => JSON.stringify(value ?? null).includes(SECRET_MASK);

/**
 * Строка поля с маской → строка формы, по парам «что модель видела — что было».
 * Маска поля маскируется по-разному (строка пары целиком, аргумент, детектор), и
 * возврат не пересчитывает её заново, а берёт исходную строку, чья маскированная
 * копия слово в слово равна присланной. Одинаковых строк с разными исходниками
 * несколько — решает ближайшая строка без маски над ней; не решает — отказ.
 */
function restoreLines(original: string, masked: string, sent: string): string | undefined {
  if (!sent.includes(SECRET_MASK)) return sent;
  const from = original.split('\n');
  const seen = masked.split('\n');
  // Маска не добавляет строк; разошлось число — возврат по значениям, как раньше.
  if (from.length !== seen.length) return restoreMaskedSecrets(original, sent);
  const entries: { line: string; original: string; context: string; used: boolean }[] = [];
  let context = '';
  seen.forEach((line, index) => {
    if (!line.includes(SECRET_MASK)) context = line;
    else entries.push({ line, original: from[index]!, context, used: false });
  });
  const agree = (list: typeof entries): boolean =>
    list.length > 0 && list.every((entry) => entry.original === list[0]!.original);
  const out: string[] = [];
  context = '';
  for (const line of sent.split('\n')) {
    if (!line.includes(SECRET_MASK)) {
      out.push(line);
      context = line;
      continue;
    }
    const free = entries.filter((entry) => !entry.used && entry.line === line);
    const near = free.filter((entry) => entry.context === context);
    const pick = agree(free) ? free[0] : agree(near) ? near[0] : undefined;
    if (!pick) return undefined;
    pick.used = true;
    out.push(pick.original);
  }
  return out.join('\n');
}

/**
 * Значение ответа с маской → значение формы. `undefined` — вернуть нечего
 * (маска переписана, лишняя, в новом месте): тогда поле не трогается вовсе.
 */
function restoreValue(original: unknown, masked: unknown, sent: unknown): unknown {
  // Модель вернула ровно то, что видела, — это прежнее значение формы.
  if (isDeepStrictEqual(sent, masked)) return original;
  if (typeof sent === 'string') {
    if (typeof original !== 'string') return undefined;
    return typeof masked === 'string'
      ? restoreLines(original, masked, sent)
      : restoreMaskedSecrets(original, sent);
  }
  if (Array.isArray(sent)) {
    const originals = Array.isArray(original) ? original : [];
    const maskedItems = Array.isArray(masked) ? masked : [];
    const out: unknown[] = [];
    for (const item of sent) {
      if (!hasMask(item)) {
        out.push(item);
        continue;
      }
      const at = maskedItems.findIndex((seen) => isDeepStrictEqual(seen, item));
      if (at < 0) return undefined;
      out.push(originals[at]);
    }
    return out;
  }
  if (sent !== null && typeof sent === 'object') {
    const from = (value: unknown): Record<string, unknown> =>
      value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(sent as Record<string, unknown>)) {
      if (!hasMask(value)) {
        out[key] = value;
        continue;
      }
      const back = restoreValue(from(original)[key], from(masked)[key], value);
      if (back === undefined) return undefined;
      out[key] = back;
    }
    return out;
  }
  return undefined;
}

export interface RestoredFields {
  fields: Record<string, unknown>;
  /** Поля, где маску вернуть некуда: оставлены как были и названы человеку. */
  kept: string[];
}

/**
 * Ответ модели → поля для формы: маска заменяется секретом формы. Не сошлось —
 * поле выпадает из ответа и попадает в `kept`: записать маску значит молча
 * стереть секрет, а угадывать, какой секрет куда, нельзя.
 */
export function restoreFormSecrets(
  original: Record<string, unknown>,
  masked: Record<string, unknown>,
  reply: Record<string, unknown>,
): RestoredFields {
  const fields: Record<string, unknown> = {};
  const kept: string[] = [];
  for (const [field, sent] of Object.entries(reply)) {
    if (!hasMask(sent)) {
      fields[field] = sent;
      continue;
    }
    const back = Object.hasOwn(original, field)
      ? restoreValue(original[field], masked[field], sent)
      : undefined;
    if (back === undefined) kept.push(field);
    else fields[field] = back;
  }
  return { fields, kept };
}
