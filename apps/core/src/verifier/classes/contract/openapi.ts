import type { ContractChange } from '@agentdeck/contracts/core/records';

/**
 * Разница OpenAPI (04:130). Сторона провода решает, ломает ли изменение: в запросе ломает новый
 * обязательный, в ответе — пропажа поля и новое значение enum. Схемы `components.schemas`,
 * на которые ссылаются (`$ref`, транзитивно) из запроса, судятся правилом запроса; из обеих
 * сторон — строже из двух (A2-F07). Ключи-описания — только там, где ключ не имя поля (B2-F05).
 */

/** Ключи-описания: их разница не меняет провод, ломающей не бывает. */
const DOC_KEYS = new Set([
  'description',
  'summary',
  'title',
  'example',
  'examples',
  'externalDocs',
  'tags',
  'deprecated',
]);

/** Карты имён: ключ под ними — имя поля, схемы, ответа, а не ключ-описание. */
const NAME_MAPS = new Set([
  'properties',
  'patternProperties',
  'schemas',
  'definitions',
  'headers',
  'parameters',
  'requestBodies',
  'responses',
  'securitySchemes',
  'links',
  'callbacks',
  'paths',
]);

type Side = 'request' | 'response' | 'both';

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function short(v: unknown): string {
  const text = JSON.stringify(v) ?? String(v);
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function isDocKey(key: string, parent: string): boolean {
  if (NAME_MAPS.has(parent)) return false;
  return DOC_KEYS.has(key) || key.startsWith('x-');
}

/** Массив параметров OpenAPI сравнивается по `in:name`, иначе перестановка = «удалено + добавлено». */
function keyed(list: unknown[]): Map<string, unknown> | null {
  if (list.length === 0 || !list.every((v) => isObject(v) && typeof v.name === 'string')) {
    return null;
  }
  return new Map(
    list.map((v) => {
      const o = v as Record<string, unknown>;
      return [`${typeof o.in === 'string' ? `${o.in}:` : ''}${o.name as string}`, v];
    }),
  );
}

function sideOf(key: string, was: Side): Side {
  if (key === 'requestBody' || key === 'parameters' || key === 'requestBodies') return 'request';
  if (key === 'responses') return 'response';
  return was;
}

/** Ломает ли изменение на этой стороне: `both` — строже из двух. */
function breaks(side: Side, onRequest: boolean, onResponse: boolean): boolean {
  if (side === 'request') return onRequest;
  if (side === 'response') return onResponse;
  return onRequest || onResponse;
}

const SCHEMA_REF = /^#\/(?:components\/schemas|definitions)\/(.+)$/;

/** Имена схем, на которые ссылаются из запроса и из ответа (транзитивно через сами схемы). */
function schemaSides(doc: unknown, into: Map<string, Set<Side>>): void {
  const schemas: Record<string, unknown> = {
    ...(isObject(doc) && isObject(doc.definitions) ? doc.definitions : {}),
    ...(isObject(doc) && isObject(doc.components) && isObject(doc.components.schemas)
      ? doc.components.schemas
      : {}),
  };
  const queue: [string, Side][] = [];
  const mark = (name: string, side: Side) => {
    const seen = into.get(name) ?? new Set<Side>();
    if (seen.has(side)) return;
    seen.add(side);
    into.set(name, seen);
    queue.push([name, side]);
  };
  const collect = (v: unknown, side: Side, at: string[]): void => {
    if (Array.isArray(v)) for (const x of v) collect(x, side, at);
    if (!isObject(v)) return;
    for (const [k, x] of Object.entries(v)) {
      if (k === '$ref' && typeof x === 'string') {
        const m = SCHEMA_REF.exec(x);
        if (m)
          mark(
            decodeURIComponent(m[1] as string)
              .replace(/~1/g, '/')
              .replace(/~0/g, '~'),
            side,
          );
        continue;
      }
      // Схемы обходятся отдельно — по ссылкам, со стороной того, кто сослался.
      if (
        (at.length === 1 && at[0] === 'components' && k === 'schemas') ||
        (at.length === 0 && k === 'definitions')
      )
        continue;
      collect(x, sideOf(k, side), [...at, k]);
    }
  };
  collect(doc, 'response', []);
  while (queue.length > 0) {
    const [name, side] = queue.shift() as [string, Side];
    collect(schemas[name], side, ['components', 'schemas', name]);
  }
}

function sideOfSchema(sides: Set<Side> | undefined): Side {
  if (!sides) return 'response';
  const req = sides.has('request') || sides.has('both');
  const resp = sides.has('response') || sides.has('both');
  if (req && resp) return 'both';
  return req ? 'request' : 'response';
}

/**
 * Значение добавлено в список / убрано из списка: `required` — ломает на запросе при добавлении и
 * на ответе при удалении, `enum` — наоборот; прочие списки — `other`.
 */
function setBreaks(field: string, op: 'added' | 'removed', side: Side, other: boolean): boolean {
  const added = op === 'added';
  if (field === 'required') return breaks(side, added, !added);
  if (field === 'enum') return breaks(side, !added, added);
  return other;
}

interface Walk {
  out: ContractChange[];
  side: Side;
  /** Внутри ключа-описания: всё поддерево — описание. */
  doc: boolean;
  sides: Map<string, Set<Side>>;
}

function scalarSet(list: unknown[]): boolean {
  return list.every((v) => v === null || typeof v !== 'object');
}

function walk(at: string, before: unknown, after: unknown, w: Walk, leaf = '', parent = ''): void {
  // `info` (название, версия документа) провода не меняет.
  const doc = w.doc || isDocKey(leaf, parent) || /^info(\.|$)/.test(at);
  if (isObject(before) && isObject(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const next = at === '' ? key : `${at}.${key}`;
      let side = sideOf(key, w.side);
      if (/^(components\.schemas|definitions)$/.test(at)) side = sideOfSchema(w.sides.get(key));
      const docKey = doc || isDocKey(key, leaf);
      if (!(key in after)) {
        w.out.push({
          kind: 'removed',
          at: next,
          // Пропало из запроса — клиент шлёт лишнее, сервер обычно терпит; пропало из ответа/путей — ломает.
          breaking: !docKey && breaks(side, false, true),
          detail: short(before[key]),
        });
      } else if (!(key in before)) {
        const required = isObject(after[key]) && after[key].required === true;
        w.out.push({
          kind: 'added',
          at: next,
          breaking: !docKey && required && breaks(side, true, false),
          detail: short(after[key]),
        });
      } else walk(next, before[key], after[key], { ...w, side, doc }, key, leaf);
    }
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const kb = keyed(before);
    const ka = keyed(after);
    if (kb && ka) {
      walk(at, Object.fromEntries(kb), Object.fromEntries(ka), w, leaf, parent);
      return;
    }
    if (scalarSet(before) && scalarSet(after)) {
      const b = new Set(before.map((v) => JSON.stringify(v)));
      const a = new Set(after.map((v) => JSON.stringify(v)));
      const field = doc ? '' : leaf;
      for (const v of a) {
        if (b.has(v)) continue;
        // Новый обязательный в запросе ломает старого клиента; новое значение enum в ответе — тоже.
        w.out.push({
          kind: 'added',
          at,
          breaking: setBreaks(field, 'added', w.side, false),
          detail: v,
        });
      }
      for (const v of b) {
        if (a.has(v)) continue;
        w.out.push({
          kind: 'removed',
          at,
          breaking: setBreaks(field, 'removed', w.side, !doc),
          detail: v,
        });
      }
      return;
    }
    const n = Math.max(before.length, after.length);
    for (let i = 0; i < n; i += 1) {
      if (i >= after.length) {
        w.out.push({
          kind: 'removed',
          at: `${at}[${i}]`,
          breaking: !doc,
          detail: short(before[i]),
        });
      } else if (i >= before.length) {
        w.out.push({ kind: 'added', at: `${at}[${i}]`, breaking: false, detail: short(after[i]) });
      } else walk(`${at}[${i}]`, before[i], after[i], { ...w, doc }, leaf, parent);
    }
    return;
  }
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  let breaking = !doc;
  // `required: false → true` у параметра ломает, обратное — нет.
  if (!doc && leaf === 'required' && typeof before === 'boolean') breaking = after === true;
  w.out.push({
    kind: 'changed',
    at,
    breaking,
    detail: `${short(before)} -> ${short(after)}`,
  });
}

export function diffOpenApi(before: unknown, after: unknown): ContractChange[] {
  const out: ContractChange[] = [];
  const sides = new Map<string, Set<Side>>();
  schemaSides(before, sides);
  schemaSides(after, sides);
  walk('', before, after, { out, side: 'response', doc: false, sides });
  return out;
}
