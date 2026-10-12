import type { ApiEndpoint } from '@entities/ApiExplorer';
import { row, type ApiDraft } from './apiRequest';

/**
 * «Заполнить примером»: случайные, но правдоподобные значения по схеме
 * контракта — чтобы запрос можно было отправить, не сочиняя тело руками.
 * Схема решает форму: `enum` — значение из списка, `format` — строка в нём
 * (uuid, email, дата), `minimum`/`maximum` и длины — в пределах; поле только
 * для чтения в запрос не идёт. Случайность — параметром: тест задаёт свою.
 */

type Schema = Record<string, unknown>;
export type Random = () => number;

const MAX_DEPTH = 5;
const WORDS = ['alpha', 'bravo', 'delta', 'orion', 'nova', 'atlas', 'zephyr', 'lumen'];
const NAMES = ['Анна Смирнова', 'Иван Петров', 'Мария Иванова', 'Олег Соколов'];

const pick = <T>(list: readonly T[], random: Random): T =>
  list[Math.floor(random() * list.length) % list.length] as T;

const int = (min: number, max: number, random: Random): number =>
  Math.floor(min + random() * (max - min + 1));

const hex = (length: number, random: Random): string =>
  Array.from({ length }, () => int(0, 15, random).toString(16)).join('');

const uuid = (random: Random): string =>
  `${hex(8, random)}-${hex(4, random)}-4${hex(3, random)}-${pick(['8', '9', 'a', 'b'], random)}${hex(3, random)}-${hex(12, random)}`;

/** Дата в пределах последнего года, от фиксированной точки — без `Date.now`, тест повторяем. */
const isoDate = (random: Random): string =>
  new Date(Date.UTC(2026, 0, 1) - int(0, 364, random) * 86_400_000 - int(0, 86_399, random) * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');

function byFormat(format: string, name: string, random: Random): string | undefined {
  switch (format) {
    case 'uuid':
      return uuid(random);
    case 'email':
      return `${pick(WORDS, random)}.${int(1, 99, random)}@example.com`;
    case 'date-time':
      return isoDate(random);
    case 'date':
      return isoDate(random).slice(0, 10);
    case 'time':
      return isoDate(random).slice(11, 19);
    case 'uri':
    case 'url':
      return `https://example.com/${pick(WORDS, random)}`;
    case 'hostname':
      return `${pick(WORDS, random)}.example.com`;
    case 'ipv4':
      return `10.${int(0, 255, random)}.${int(0, 255, random)}.${int(1, 254, random)}`;
    case 'ipv6':
      return `fd00::${hex(4, random)}`;
    case 'password':
      return `Qa-${hex(10, random)}`;
    default:
      return name ? byName(name, random) : undefined;
  }
}

/** Имя поля подсказывает смысл, когда формат не задан: `email`, `name`, `phone`… */
function byName(name: string, random: Random): string | undefined {
  const key = name.toLowerCase();
  if (/e-?mail/.test(key)) return byFormat('email', '', random);
  if (/(^|_)id$|uuid|guid/.test(key)) return uuid(random);
  if (/phone|tel/.test(key))
    return `+7 9${int(10, 99, random)} ${int(100, 999, random)}-${int(10, 99, random)}-${int(10, 99, random)}`;
  if (/url|link|href|uri/.test(key)) return byFormat('uri', '', random);
  if (/(^|_)(at|date|time)$|timestamp/.test(key)) return isoDate(random);
  if (/^(full_?)?name$|author|owner/.test(key)) return pick(NAMES, random);
  if (/host|domain/.test(key)) return byFormat('hostname', '', random);
  if (/version/.test(key)) return `${int(0, 3, random)}.${int(0, 20, random)}.${int(0, 9, random)}`;
  return undefined;
}

const typeOf = (schema: Schema): string | undefined => {
  const type = schema.type;
  if (Array.isArray(type)) return type.find((item) => item !== 'null') as string | undefined;
  if (typeof type === 'string') return type;
  if (schema.properties) return 'object';
  if (schema.items) return 'array';
  return undefined;
};

function stringValue(schema: Schema, name: string, random: Random): string {
  const format = typeof schema.format === 'string' ? schema.format : '';
  let value = byFormat(format, name, random) ?? `${pick(WORDS, random)}-${int(1, 999, random)}`;
  const min = typeof schema.minLength === 'number' ? schema.minLength : 0;
  const max = typeof schema.maxLength === 'number' ? schema.maxLength : undefined;
  while (value.length < min) value += pick(WORDS, random);
  if (max !== undefined && value.length > max) value = value.slice(0, Math.max(max, min));
  return value;
}

/** Граница диапазона: `minimum` (с флагом исключения из 3.0) или числовой `exclusiveMinimum` из 3.1. */
function bound(inclusive: unknown, exclusive: unknown, step: 1 | -1): number | undefined {
  if (typeof inclusive === 'number') return inclusive + (exclusive === true ? step : 0);
  if (typeof exclusive === 'number') return exclusive + step;
  return undefined;
}

function numberValue(schema: Schema, integer: boolean, random: Random): number {
  const low = bound(schema.minimum, schema.exclusiveMinimum, 1) ?? 1;
  const high = bound(schema.maximum, schema.exclusiveMaximum, -1) ?? Math.max(low, 0) + 100;
  if (integer) return int(Math.ceil(low), Math.max(Math.ceil(low), Math.floor(high)), random);
  return Math.round((low + random() * Math.max(0, high - low)) * 100) / 100;
}

/** Значение по схеме; `undefined` — у схемы нет формы (цикл, пустая схема без типа). */
export function sampleFromSchema(
  schema: Schema | undefined,
  random: Random = Math.random,
  name = '',
  depth = 0,
): unknown {
  if (!schema || depth > MAX_DEPTH || schema.$circular) return undefined;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return pick(schema.enum, random);
  if ('const' in schema) return schema.const;
  const variants = (schema.oneOf ?? schema.anyOf) as Schema[] | undefined;
  if (Array.isArray(variants) && variants.length > 0)
    return sampleFromSchema(pick(variants, random), random, name, depth + 1);
  if (Array.isArray(schema.allOf)) {
    const merged = (schema.allOf as Schema[]).reduce<Schema>(
      (all, part) => ({
        ...all,
        ...part,
        properties: { ...(all.properties as Schema), ...(part.properties as Schema) },
        required: [...((all.required as string[]) ?? []), ...((part.required as string[]) ?? [])],
      }),
      { type: 'object' },
    );
    return sampleFromSchema(merged, random, name, depth + 1);
  }
  switch (typeOf(schema)) {
    case 'object': {
      const properties = (schema.properties ?? {}) as Record<string, Schema>;
      const result: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(properties)) {
        if (child.readOnly === true) continue;
        const value = sampleFromSchema(child, random, key, depth + 1);
        if (value !== undefined) result[key] = value;
      }
      return result;
    }
    case 'array': {
      const min = typeof schema.minItems === 'number' ? schema.minItems : 1;
      const max = typeof schema.maxItems === 'number' ? schema.maxItems : Math.max(min, 2);
      const items = Array.from({ length: int(min, Math.max(min, max), random) }, () =>
        sampleFromSchema(schema.items as Schema | undefined, random, name, depth + 1),
      ).filter((item) => item !== undefined);
      return items;
    }
    case 'string':
      return stringValue(schema, name, random);
    case 'integer':
      return numberValue(schema, true, random);
    case 'number':
      return numberValue(schema, false, random);
    case 'boolean':
      return random() < 0.5;
    default:
      return undefined;
  }
}

function asParam(value: unknown): string {
  if (value === undefined) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * Черновик с примером: параметры пути, запроса и заголовки из контракта
 * получают значения по схеме, тело JSON — пример целиком. Включённость строк
 * не меняется (необязательный параметр без галочки так и не уйдёт), строки,
 * которые человек добавил сам, не трогаются. Возвращает и число заполненных полей.
 */
export function fillWithSample(
  draft: ApiDraft,
  endpoint: ApiEndpoint,
  random: Random = Math.random,
): { draft: ApiDraft; filled: number } {
  let filled = 0;
  const pathValues = { ...draft.pathValues };
  const query = [...draft.query];
  const headers = [...draft.headers];
  for (const param of endpoint.params) {
    const value = asParam(sampleFromSchema(param.schema ?? { type: 'string' }, random, param.name));
    if (!value) continue;
    if (param.in === 'path') {
      pathValues[param.name] = value;
      filled += 1;
      continue;
    }
    const list = param.in === 'query' ? query : headers;
    const at = list.findIndex((item) => item.name === param.name);
    if (at >= 0) list[at] = { ...(list[at] as (typeof list)[number]), value };
    else list.push(row(param.name, value, param.required));
    filled += 1;
  }
  let body = draft.body;
  const jsonBody = endpoint.body && /[/+]json\b/i.test(endpoint.body.contentType);
  if (jsonBody && endpoint.body?.schema) {
    const sample = sampleFromSchema(endpoint.body.schema, random);
    if (sample !== undefined) {
      body = JSON.stringify(sample, null, 2);
      filled += 1;
    }
  }
  return { draft: { ...draft, pathValues, query, headers, body }, filled };
}
