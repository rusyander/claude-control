import type { ContractChange } from '@agentdeck/contracts/core/records';

/**
 * Разница proto (04:130). Разбор — лексер и рекурсия по фигурным скобкам, а не разрез по `}`
 * (A2-F06/B2-F05): тело rpc `{}` / `{ option … }`, агрегат `option x = { … }` и опции поля
 * `[…]` не выталкивают область, и rpc/поля после них видны. Конструкция, которую разбор не
 * знает, — в `unparsed`: прогон класса тогда без вердикта, а не «изменений нет».
 */

interface ProtoField {
  type: string;
  name: string;
}

export interface ProtoShape {
  /** `Message#номер` → поле: провод знает номер, а не имя. */
  fields: Map<string, ProtoField>;
  /** `Service.Rpc` → `(In) returns (Out)`. */
  rpcs: Map<string, string>;
  /** `Enum.VALUE` → номер. */
  enumValues: Map<string, string>;
  types: Set<string>;
  /** Нераспознанные конструкции (начало текста) — без них разница была бы молча неполной. */
  unparsed: string[];
}

type Scope = 'file' | 'message' | 'enum' | 'service' | 'oneof' | 'extend';

const STRING_TOKEN = '"…"';

function lex(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    if (/\s/.test(c)) i += 1;
    else if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      i = end < 0 ? text.length : end;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
    } else if (c === '"' || c === "'") {
      i += 1;
      while (i < text.length && text[i] !== c) i += text[i] === '\\' ? 2 : 1;
      i += 1;
      out.push(STRING_TOKEN);
    } else if (/[\w.+-]/.test(c)) {
      const m = /^[\w.+-]+/.exec(text.slice(i)) as RegExpExecArray;
      out.push(m[0]);
      i += m[0].length;
    } else {
      out.push(c);
      i += 1;
    }
  }
  return out;
}

class Cursor {
  i = 0;
  readonly t: string[];
  constructor(tokens: string[]) {
    this.t = tokens;
  }
  get done(): boolean {
    return this.i >= this.t.length;
  }
  peek(): string | undefined {
    return this.t[this.i];
  }
  /** Пропуск сбалансированного блока от открывающей скобки на курсоре. */
  skipBalanced(open: string, close: string): void {
    let level = 0;
    while (!this.done) {
      const tok = this.t[this.i++];
      if (tok === open) level += 1;
      else if (tok === close && --level === 0) return;
    }
  }
}

/** Один оператор до `;` или `{` (опции `[…]` пропущены); конец — какой разделитель встретился. */
function statement(c: Cursor): { words: string[]; end: ';' | '{' | '}' | 'eof' } {
  const words: string[] = [];
  while (!c.done) {
    const tok = c.peek() as string;
    if (tok === '[') {
      c.skipBalanced('[', ']');
      continue;
    }
    if (tok === ';' || tok === '{' || tok === '}') {
      c.i += tok === '}' ? 0 : 1;
      return { words, end: tok };
    }
    words.push(tok);
    c.i += 1;
  }
  return { words, end: 'eof' };
}

/** Слова оператора в одну строку: `map < a , b > m = 2` → `map<a,b> m=2` (пробел после `>` — граница имени). */
const norm = (words: string[]) =>
  words
    .join(' ')
    .replace(/\s*([<,()=])\s*/g, '$1')
    .replace(/\s+>/g, '>');

const FIELD = /^(?:(repeated|optional|required) )?(map<[^>]+>|[\w.]+) (\w+)=(\d+)$/;
const RPC = /^rpc (\w+)\((stream )?([\w.]+)\)returns\((stream )?([\w.]+)\)$/;
const ENUM_VALUE = /^(\w+)=(-?\w+)$/;

function body(c: Cursor, scope: Scope, owner: string, shape: ProtoShape): void {
  const named = (n: string) => (owner ? `${owner}.${n}` : n);
  while (!c.done) {
    if (c.peek() === '}') {
      c.i += 1;
      if (scope !== 'file') return;
      shape.unparsed.push('unbalanced }');
      continue;
    }
    const { words, end } = statement(c);
    if (end === 'eof' && words.length === 0) return;
    const text = norm(words);
    const head = words[0];
    if (end === '{') {
      const kind = head as Scope;
      if (
        ['message', 'enum', 'service', 'oneof', 'extend'].includes(head ?? '') &&
        words.length === 2
      ) {
        const name = words[1] as string;
        if (kind === 'message' || kind === 'enum' || kind === 'service')
          shape.types.add(named(name));
        // oneof — не тип: его поля принадлежат сообщению вокруг; extend — чужое сообщение.
        let inner = named(name);
        if (kind === 'oneof') inner = owner;
        else if (kind === 'extend') inner = `(extend ${name})`;
        body(c, kind, inner, shape);
        continue;
      }
      c.i -= 1;
      if (head === 'option' && words.at(-1) === '=') {
        c.skipBalanced('{', '}');
        if (c.peek() === ';') c.i += 1;
        continue;
      }
      const rpc = scope === 'service' ? RPC.exec(text) : null;
      c.skipBalanced('{', '}');
      if (rpc) {
        shape.rpcs.set(
          named(rpc[1] as string),
          `(${rpc[2] ?? ''}${rpc[3]}) returns (${rpc[4] ?? ''}${rpc[5]})`,
        );
        continue;
      }
      shape.unparsed.push(text.slice(0, 60));
      continue;
    }
    if (end === '}' || end === 'eof') {
      if (words.length > 0) shape.unparsed.push(text.slice(0, 60));
      continue;
    }
    if (words.length === 0 || head === 'option') continue;
    if (scope === 'file' && ['syntax', 'edition', 'package', 'import'].includes(head ?? ''))
      continue;
    if ((scope === 'message' || scope === 'enum') && (head === 'reserved' || head === 'extensions'))
      continue;
    if (scope === 'service') {
      const rpc = RPC.exec(text);
      if (rpc) {
        shape.rpcs.set(
          named(rpc[1] as string),
          `(${rpc[2] ?? ''}${rpc[3]}) returns (${rpc[4] ?? ''}${rpc[5]})`,
        );
        continue;
      }
    }
    if (scope === 'enum') {
      const value = ENUM_VALUE.exec(text);
      if (value) {
        shape.enumValues.set(named(value[1] as string), value[2] as string);
        continue;
      }
    }
    if (scope === 'message' || scope === 'oneof' || scope === 'extend') {
      const field = FIELD.exec(text);
      if (field) {
        const type = `${field[1] ? `${field[1]} ` : ''}${field[2] as string}`;
        shape.fields.set(`${owner}#${field[4]}`, { type, name: field[3] as string });
        continue;
      }
    }
    shape.unparsed.push(text.slice(0, 60));
  }
}

export function parseProto(text: string): ProtoShape {
  const shape: ProtoShape = {
    fields: new Map(),
    rpcs: new Map(),
    enumValues: new Map(),
    types: new Set(),
    unparsed: [],
  };
  body(new Cursor(lex(text)), 'file', '', shape);
  return shape;
}

export function diffProto(beforeText: string, afterText: string): ContractChange[] {
  const b = parseProto(beforeText);
  const a = parseProto(afterText);
  const out: ContractChange[] = [];
  for (const type of b.types) {
    if (!a.types.has(type)) out.push({ kind: 'removed', at: type, breaking: true, detail: 'type' });
  }
  for (const type of a.types) {
    if (!b.types.has(type)) out.push({ kind: 'added', at: type, breaking: false, detail: 'type' });
  }
  for (const [key, field] of b.fields) {
    const msg = key.split('#')[0] as string;
    const now = a.fields.get(key);
    if (!now) {
      if (a.types.has(msg) || msg.startsWith('(extend ')) {
        out.push({
          kind: 'removed',
          at: `${msg}.${field.name}`,
          breaking: true,
          detail: `#${key.split('#')[1]}`,
        });
      }
      continue;
    }
    if (now.type !== field.type) {
      out.push({
        kind: 'changed',
        at: `${msg}.${field.name}`,
        breaking: true,
        detail: `${field.type} -> ${now.type}`,
      });
    } else if (now.name !== field.name) {
      // Номер тот же — провод цел; ломается JSON-отображение и сгенерированный код, это видит drift.
      out.push({
        kind: 'changed',
        at: `${msg}.${field.name}`,
        breaking: false,
        detail: `renamed -> ${now.name}`,
      });
    }
  }
  for (const [key, field] of a.fields) {
    if (b.fields.has(key)) continue;
    const msg = key.split('#')[0] as string;
    // Поля нового сообщения — часть его «добавлено», отдельной строкой не дублируются.
    if (!b.types.has(msg) && !msg.startsWith('(extend ')) continue;
    out.push({
      kind: 'added',
      at: `${msg}.${field.name}`,
      breaking: false,
      detail: `#${key.split('#')[1]}`,
    });
  }
  for (const [rpc, sig] of b.rpcs) {
    const now = a.rpcs.get(rpc);
    if (now === undefined) out.push({ kind: 'removed', at: rpc, breaking: true, detail: sig });
    else if (now !== sig)
      out.push({ kind: 'changed', at: rpc, breaking: true, detail: `${sig} -> ${now}` });
  }
  for (const [rpc, sig] of a.rpcs) {
    if (!b.rpcs.has(rpc)) out.push({ kind: 'added', at: rpc, breaking: false, detail: sig });
  }
  for (const [value, n] of b.enumValues) {
    const now = a.enumValues.get(value);
    if (now === undefined) out.push({ kind: 'removed', at: value, breaking: true, detail: n });
    else if (now !== n)
      out.push({ kind: 'changed', at: value, breaking: true, detail: `${n} -> ${now}` });
  }
  for (const [value, n] of a.enumValues) {
    if (!b.enumValues.has(value))
      out.push({ kind: 'added', at: value, breaking: false, detail: n });
  }
  return out;
}
