import type {
  ApiEndpoint,
  ApiResponseSpec,
  ApiSchema,
  ApiSchemaCheck,
  ApiSchemaIssue,
} from '@agentdeck/contracts';
import { isNode } from './api-explorer.types.ts';
import { schemaType } from './schema.ts';

/**
 * Сверка ответа со схемой контракта — своё подмножество JSON Schema, без ajv:
 * type (с nullable и списком типов 3.1), properties/required,
 * additionalProperties, items, enum/const, allOf/oneOf/anyOf и форматы
 * date-time/date/email/uuid. Для «ответ не тот, что в контракте» этого хватает,
 * а чего нет (pattern, minLength, …) — не ругаем: ложная тревога хуже молчания.
 */

const MAX_ISSUES = 50;
const JSON_TYPE = /[/+]json\b/i;

const FORMATS: Record<string, RegExp> = {
  'date-time': /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:?\d{2})?$/,
  date: /^\d{4}-\d{2}-\d{2}$/,
  email: /^[^\s@]+@[^\s@]+$/,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
};

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function short(value: unknown): string {
  const text = typeof value === 'string' ? JSON.stringify(value) : String(JSON.stringify(value));
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

const childPath = (path: string, key: string): string =>
  /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;

function typeMatches(expected: string, value: unknown): boolean {
  const actual = typeOf(value);
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  return expected === actual;
}

function allowedTypes(schema: ApiSchema): string[] | undefined {
  const type = schema.type;
  if (typeof type !== 'string' && !Array.isArray(type)) return undefined;
  const list = typeof type === 'string' ? [type] : type.map(String);
  return schema.nullable === true ? [...list, 'null'] : list;
}

/** Все расхождения значения со схемой (до `MAX_ISSUES`). */
export function validateValue(schema: unknown, value: unknown, path = '$'): ApiSchemaIssue[] {
  const issues: ApiSchemaIssue[] = [];
  walk(schema, value, path, issues);
  return issues;
}

function walk(schema: unknown, value: unknown, path: string, issues: ApiSchemaIssue[]): void {
  if (issues.length >= MAX_ISSUES || !isNode(schema)) return;
  // Обрезанный цикл и внешняя ссылка — проверять не по чему.
  if (schema.$circular !== undefined || typeof schema.$ref === 'string') return;

  if (Array.isArray(schema.allOf)) for (const part of schema.allOf) walk(part, value, path, issues);
  for (const key of ['oneOf', 'anyOf'] as const) {
    const options = schema[key];
    if (!Array.isArray(options) || options.length === 0) continue;
    const fits = options.some((option) => validateValue(option, value, path).length === 0);
    if (!fits) {
      issues.push({
        path,
        kind: 'one-of',
        // Число вариантов — подпись строит клиент.
        expected: String(options.length),
        actual: typeOf(value),
      });
      return;
    }
  }

  const types = allowedTypes(schema);
  if (value === null && schema.nullable === true) return;
  if (types && !types.some((type) => typeMatches(type, value))) {
    issues.push({ path, kind: 'type', expected: types.join(' | '), actual: typeOf(value) });
    return;
  }
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))
  ) {
    issues.push({
      path,
      kind: 'enum',
      expected: schema.enum.map(short).join(', '),
      actual: short(value),
    });
    return;
  }
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) {
    issues.push({ path, kind: 'enum', expected: short(schema.const), actual: short(value) });
    return;
  }
  if (typeof value === 'string' && typeof schema.format === 'string') {
    const format = FORMATS[schema.format];
    if (format && !format.test(value))
      issues.push({ path, kind: 'format', expected: schema.format, actual: short(value) });
  }

  const kind = schemaType(schema);
  if (Array.isArray(value) && (kind === 'array' || schema.items !== undefined)) {
    value.forEach((item, index) => walk(schema.items, item, `${path}[${index}]`, issues));
    return;
  }
  if (!isNode(value)) return;
  const properties = isNode(schema.properties) ? schema.properties : {};
  if (Array.isArray(schema.required)) {
    for (const name of schema.required) {
      if (typeof name === 'string' && !(name in value))
        issues.push({ path: childPath(path, name), kind: 'required', expected: name });
    }
  }
  for (const [key, item] of Object.entries(value)) {
    const own = properties[key];
    if (own !== undefined) walk(own, item, childPath(path, key), issues);
    else if (schema.additionalProperties === false)
      issues.push({ path: childPath(path, key), kind: 'additional', actual: short(item) });
    else if (isNode(schema.additionalProperties))
      walk(schema.additionalProperties, item, childPath(path, key), issues);
  }
}

/** Ответ контракта для кода: точный, потом `2XX`, потом `default`. */
export function responseFor(endpoint: ApiEndpoint, status: number): ApiResponseSpec | undefined {
  const exact = endpoint.responses.find((response) => response.status === String(status));
  if (exact) return exact;
  const range = `${String(status)[0]}XX`;
  return (
    endpoint.responses.find((response) => response.status.toUpperCase() === range) ??
    endpoint.responses.find((response) => response.status === 'default')
  );
}

/**
 * Вердикт по ответу. У эндпоинта без описанных ответов (запрос из Postman)
 * сверять не с чем — `undefined`, и вкладка вердикта не показывает.
 */
export function checkResponse(
  endpoint: ApiEndpoint,
  status: number,
  contentType: string | undefined,
  body: string,
): ApiSchemaCheck | undefined {
  if (endpoint.responses.length === 0) return undefined;
  const spec = responseFor(endpoint, status);
  if (!spec) return { verdict: 'undocumented-status', issues: [] };
  const against = spec.status;
  if (!spec.schema) return { verdict: 'no-schema', against, issues: [] };
  const expectsJson = !spec.contentType || JSON_TYPE.test(spec.contentType);
  if (!expectsJson) return { verdict: 'no-schema', against, issues: [] };
  let value: unknown;
  try {
    if (
      contentType &&
      !JSON_TYPE.test(contentType) &&
      !/^\s*[[{"\d-]|^\s*(true|false|null)\s*$/.test(body)
    )
      throw new Error('not json');
    value = JSON.parse(body);
  } catch {
    return { verdict: 'not-json', against, issues: [] };
  }
  const issues = validateValue(spec.schema, value);
  if (issues.length === 0) return { verdict: 'ok', against, issues };
  return {
    verdict: 'mismatch',
    against,
    issues,
    ...(issues.length >= MAX_ISSUES ? { truncated: true } : {}),
  };
}
