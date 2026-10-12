import type { ApiSchema } from '@agentdeck/contracts';
import { isNode, type JsonNode } from './api-explorer.types.ts';

/**
 * Ссылки `$ref` контракта и пример тела по схеме. Ссылки только внутренние
 * (`#/components/schemas/User`): внешний файл панель не тянет, оставляет ссылку
 * как есть и пишет предупреждение. Цикл (`User.manager: User`) обрезается
 * `{ $circular: 'User' }` — валидатор такое место принимает любым.
 */

const MAX_DEPTH = 40;

export interface Dereffer {
  /** Копия узла со всеми внутренними ссылками на месте. */
  resolve: (node: unknown) => unknown;
  /** Внешние ссылки, которые остались как есть. */
  external: Set<string>;
}

function pointer(doc: JsonNode, ref: string): unknown {
  const parts = ref
    .slice(2)
    .split('/')
    .map((part) => decodeURIComponent(part.replace(/~1/g, '/').replace(/~0/g, '~')));
  let current: unknown = doc;
  for (const part of parts) {
    if (!isNode(current) && !Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function createDereffer(doc: JsonNode): Dereffer {
  const external = new Set<string>();
  const done = new Map<string, unknown>();

  const walk = (node: unknown, stack: string[]): unknown => {
    if (stack.length > MAX_DEPTH) return {};
    if (Array.isArray(node)) return node.map((item) => walk(item, stack));
    if (!isNode(node)) return node;
    const ref = node.$ref;
    if (typeof ref === 'string') {
      if (!ref.startsWith('#/')) {
        external.add(ref);
        return { $ref: ref };
      }
      const name = ref.slice(ref.lastIndexOf('/') + 1);
      if (stack.includes(ref)) return { $circular: name };
      const cached = done.get(ref);
      if (cached !== undefined) return cached;
      const target = pointer(doc, ref);
      if (target === undefined) {
        external.add(ref);
        return { $ref: ref };
      }
      const resolved = walk(target, [...stack, ref]);
      // Кэш только для ветки без обрезанного цикла: обрезка зависит от того,
      // откуда пришли, и чужая обрезка в другом месте схемы была бы неправдой.
      if (!JSON.stringify(resolved).includes('"$circular"')) done.set(ref, resolved);
      return resolved;
    }
    const out: JsonNode = {};
    for (const [key, value] of Object.entries(node)) out[key] = walk(value, stack);
    return out;
  };

  return { resolve: (node) => walk(node, []), external };
}

/** Тип схемы: у OpenAPI 3.1 он бывает списком (`['string', 'null']`). */
export function schemaType(schema: ApiSchema): string | undefined {
  const type = schema.type;
  if (typeof type === 'string') return type;
  if (Array.isArray(type)) return type.find((item) => item !== 'null') as string | undefined;
  if (isNode(schema.properties)) return 'object';
  if (schema.items !== undefined) return 'array';
  return undefined;
}

const STRING_SAMPLES: Record<string, string> = {
  'date-time': '2026-01-01T12:00:00Z',
  date: '2026-01-01',
  time: '12:00:00',
  email: 'user@example.com',
  uuid: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
  uri: 'https://example.com',
  url: 'https://example.com',
  hostname: 'example.com',
  ipv4: '127.0.0.1',
  password: 'secret',
};

/** Пример значения по схеме — чтобы тело запроса не набирать с нуля. */
export function exampleFromSchema(schema: unknown, depth = 0): unknown {
  if (!isNode(schema) || depth > 8) return undefined;
  if (schema.example !== undefined) return schema.example;
  if (Array.isArray(schema.examples) && schema.examples.length > 0) return schema.examples[0];
  if (schema.default !== undefined) return schema.default;
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if (Array.isArray(schema.allOf)) {
    const merged: JsonNode = {};
    for (const part of schema.allOf) {
      const sample = exampleFromSchema(part, depth + 1);
      if (isNode(sample)) Object.assign(merged, sample);
    }
    return merged;
  }
  for (const key of ['oneOf', 'anyOf'] as const) {
    const options = schema[key];
    if (Array.isArray(options) && options.length > 0)
      return exampleFromSchema(options[0], depth + 1);
  }
  if (schema.$circular !== undefined) return {};
  switch (schemaType(schema)) {
    case 'object': {
      const out: JsonNode = {};
      if (isNode(schema.properties)) {
        for (const [key, property] of Object.entries(schema.properties)) {
          if (isNode(property) && property.readOnly === true) continue;
          out[key] = exampleFromSchema(property, depth + 1) ?? null;
        }
      }
      return out;
    }
    case 'array': {
      const item = exampleFromSchema(schema.items, depth + 1);
      return item === undefined ? [] : [item];
    }
    case 'string':
      return STRING_SAMPLES[String(schema.format)] ?? 'string';
    case 'integer':
    case 'number':
      return typeof schema.minimum === 'number' ? schema.minimum : 0;
    case 'boolean':
      return true;
    default:
      return undefined;
  }
}
