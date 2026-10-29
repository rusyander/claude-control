import type { ContractChange } from '@agentdeck/contracts/core/records';

/**
 * Разница GraphQL SDL (04:130). Определения верхнего уровня: type / input / interface / enum
 * (с `extend`), union (члены — как поля), scalar, schema, directive (A2-F12/B2-F05). Прочее —
 * в `unparsed`: прогон класса без вердикта, а не молча пустая разница.
 */

export interface GqlType {
  kind: string;
  /** Поле → тип (с аргументами в скобках, нормализовано); у union — член, у directive — место. */
  fields: Map<string, string>;
}

export interface GqlShape {
  types: Map<string, GqlType>;
  unparsed: string[];
}

const HEAD = /\s*(extend\s+)?(type|input|interface|enum|union|scalar|schema|directive)\b/y;
const NAME = /\s*(\w+)/y;
/** `implements A & B` и директивы `@x(…)` между именем и телом. */
const DECOR = /(?:\s*(?:implements\s*&?\s*\w+(?:\s*&\s*\w+)*|@\w+(?:\s*\([^)]*\))?))*/y;
const UNION_MEMBERS = /\s*=\s*\|?\s*(\w+(?:\s*\|\s*\w+)*)/y;
const DIRECTIVE = /\s*@(\w+)\s*(\([^)]*\))?\s*(?:repeatable\s+)?on\s+\|?\s*(\w+(?:\s*\|\s*\w+)*)/y;

function sticky(re: RegExp, text: string, at: number): RegExpExecArray | null {
  re.lastIndex = at;
  return re.exec(text);
}

/** Тело `{…}` от позиции (пробелы допустимы); нет `{` — null и позиция та же. */
function braceBody(text: string, at: number): { body: string; end: number } | null {
  const open = /\s*\{/y;
  open.lastIndex = at;
  if (!open.exec(text)) return null;
  let level = 1;
  let i = open.lastIndex;
  for (; i < text.length && level > 0; i += 1) {
    if (text[i] === '{') level += 1;
    else if (text[i] === '}') level -= 1;
  }
  return { body: text.slice(open.lastIndex, i - 1), end: i };
}

const compact = (s: string) => s.replace(/\s+/g, ' ').replace(/\s*([(),:|])\s*/g, '$1');

function fieldsOf(body: string, kind: string): Map<string, string> {
  const fields = new Map<string, string>();
  if (kind === 'enum') {
    for (const v of body.split(/[\s,]+/).filter((s) => /^\w+$/.test(s))) fields.set(v, 'enum');
    return fields;
  }
  const fieldRe = /(\w+)\s*(\([^)]*\))?\s*:\s*([\w[\]!]+)/g;
  for (let f = fieldRe.exec(body); f; f = fieldRe.exec(body)) {
    fields.set(f[1] as string, `${compact(f[2] ?? '')}${f[3] as string}`);
  }
  return fields;
}

export function parseGraphqlShape(text: string): GqlShape {
  const clean = text
    .replace(/"""[\s\S]*?"""/g, ' ')
    .replace(/"(?:\\.|[^"\\])*"/g, ' ')
    .replace(/#[^\n]*/g, ' ');
  const types = new Map<string, GqlType>();
  const unparsed: string[] = [];
  const merge = (name: string, kind: string, fields: Map<string, string>) => {
    const t = types.get(name) ?? { kind, fields: new Map<string, string>() };
    for (const [k, v] of fields) t.fields.set(k, v);
    types.set(name, t);
  };
  let at = 0;
  while (at < clean.length) {
    if (/^\s*$/.test(clean.slice(at))) break;
    const head = sticky(HEAD, clean, at);
    if (!head) {
      unparsed.push(clean.slice(at).trim().slice(0, 60));
      break;
    }
    at = HEAD.lastIndex;
    const kind = head[2] as string;
    if (kind === 'directive') {
      const d = sticky(DIRECTIVE, clean, at);
      if (!d) {
        unparsed.push(`directive${clean.slice(at, at + 50)}`.trim());
        break;
      }
      at = DIRECTIVE.lastIndex;
      const fields = new Map<string, string>([['()', compact(d[2] ?? '')]]);
      for (const loc of (d[3] as string).split('|')) fields.set(loc.trim(), 'location');
      merge(`@${d[1] as string}`, 'directive', fields);
      continue;
    }
    let name = 'schema';
    if (kind !== 'schema') {
      const n = sticky(NAME, clean, at);
      if (!n) {
        unparsed.push(`${kind}${clean.slice(at, at + 50)}`.trim());
        break;
      }
      name = n[1] as string;
      at = NAME.lastIndex;
    }
    sticky(DECOR, clean, at);
    at = DECOR.lastIndex;
    if (kind === 'scalar') {
      merge(name, 'scalar', new Map());
      continue;
    }
    if (kind === 'union') {
      const m = sticky(UNION_MEMBERS, clean, at);
      const fields = new Map<string, string>();
      if (m) {
        at = UNION_MEMBERS.lastIndex;
        for (const member of (m[1] as string).split('|')) fields.set(member.trim(), 'member');
      }
      merge(name, 'union', fields);
      continue;
    }
    const body = braceBody(clean, at);
    if (body) at = body.end;
    merge(name, kind, body ? fieldsOf(body.body, kind) : new Map());
  }
  return { types, unparsed };
}

export function parseGraphql(text: string): Map<string, GqlType> {
  return parseGraphqlShape(text).types;
}

export function diffGraphql(beforeText: string, afterText: string): ContractChange[] {
  const b = parseGraphql(beforeText);
  const a = parseGraphql(afterText);
  const out: ContractChange[] = [];
  for (const [name, t] of b) {
    const now = a.get(name);
    if (!now) {
      out.push({ kind: 'removed', at: name, breaking: true, detail: t.kind });
      continue;
    }
    for (const [field, sig] of t.fields) {
      const got = now.fields.get(field);
      if (got === undefined) {
        out.push({ kind: 'removed', at: `${name}.${field}`, breaking: true, detail: sig });
      } else if (got !== sig) {
        // Выход стал строже (`T` → `T!`) или вход мягче (`T!` → `T`) — старый клиент цел.
        const safe = t.kind === 'input' ? sig === `${got}!` : got === `${sig}!`;
        out.push({
          kind: 'changed',
          at: `${name}.${field}`,
          breaking: !safe,
          detail: `${sig} -> ${got}`,
        });
      }
    }
    for (const [field, sig] of now.fields) {
      if (t.fields.has(field)) continue;
      // Новое обязательное поле входного типа ломает старых клиентов; в выходном — нет.
      const breaking = t.kind === 'input' && sig.endsWith('!');
      out.push({ kind: 'added', at: `${name}.${field}`, breaking, detail: sig });
    }
  }
  for (const [name, t] of a) {
    if (!b.has(name)) out.push({ kind: 'added', at: name, breaking: false, detail: t.kind });
  }
  return out;
}
