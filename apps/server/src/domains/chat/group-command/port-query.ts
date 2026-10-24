import { ENTER, LEAVE, parse, UNPARSED, type Segment, type Word } from './shell-parse.ts';

/**
 * Запрос «кто слушает порт N» в подстановке (R-C03, ревью корпуса 23.10):
 * `$(netstat -ano | grep ':5173 ' | grep LISTENING | awk '{print $5}')`,
 * `$(lsof -t -iTCP:5173 -sTCP:LISTEN)`. Его вывод — номера держателей порта, и
 * погашение по нему — погашение порта: чьи держатели, проверит маршрут прав
 * (`killsOwnOnly`). Узнаётся только труба, чей вывод НЕ шире держателей: отбор
 * LISTEN, порт с границей (`:5173 `, не `:5173` — тот поймает и :51730), без
 * `grep -v`/`-o` и с `awk` только печатью поля.
 */

/** Значения переменной цикла (`for p in 5173 5174`), если обход их знает. */
export type LoopValues = (name: string) => readonly string[] | undefined;

/** `findstr "a b"` — «a или b»: его отбор шире, чем выглядит, поэтому его нет. */
const FILTERS = new Set(['grep', 'awk', 'head', 'tail', 'sort', 'uniq']);
const PORT_GROUP = /\(\d{1,5}(?:\|\d{1,5})*\)/g;
const GREP_FLAG = /^-[EiFw]+$/;
const AWK_PRINT = /^\{\s*print\s+\$(\d+|NF)\s*\}$/;
const COUNT_FLAG = /^-(n\s*)?\d*$|^\d+$/;
/** Порт с границей после: пробел, `\s`, `\b`, `[[:space:]]`, конец строки. */
const PORT_IN_PATTERN =
  /(?::|\[:\.\]|\[\.:\])(\d{1,5}|\$\{?([A-Za-z_]\w*)\}?|\((\d{1,5}(?:\|\d{1,5})*)\))(?= |\\s|\\b|\[\[:space:\]\]|\$(?!\w|\{))/g;

/** Текст подстановки `$(…)` / `` `…` `` — слово целиком, без вложенных. */
function substitutionBody(text: string): string | undefined {
  const body = /^\$\(([\s\S]*)\)$/.exec(text)?.[1] ?? /^`([^`]*)`$/.exec(text)?.[1];
  if (body === undefined || body.includes('$(') || body.includes('`')) return undefined;
  return body;
}

function portsOfPattern(pattern: string, loops: LoopValues): number[] | undefined {
  const ports: number[] = [];
  for (const match of pattern.matchAll(PORT_IN_PATTERN)) {
    const [, literal, variable, group] = match;
    let texts: readonly string[] = [];
    if (variable) {
      const values = loops(variable);
      if (!values) return undefined;
      texts = values;
    } else if (group) texts = group.split('|');
    else if (literal) texts = [literal];
    for (const text of texts) {
      if (!/^\d{1,5}$/.test(text) || Number(text) === 0 || Number(text) > 65535) return undefined;
      ports.push(Number(text));
    }
  }
  return ports;
}

/** `lsof -t -iTCP:5173 -sTCP:LISTEN`, `lsof -ti :5173 -sTCP:LISTEN`. */
function lsofPorts(args: Word[]): number[] | undefined {
  let listen = false;
  let terse = false;
  const ports: number[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const text = (args[i] as Word).text;
    if ((args[i] as Word).dynamic) return undefined;
    if (text === '-sTCP:LISTEN') {
      listen = true;
      continue;
    }
    const inline = /^-([nPt]*)i(?:TCP|tcp)?(:\d{1,5})?$/.exec(text);
    if (inline) {
      terse ||= (inline[1] ?? '').includes('t');
      const spec = inline[2] ?? args[(i += 1)]?.text;
      const port = /^(?:TCP|tcp)?:(\d{1,5})$/.exec(spec ?? '')?.[1];
      if (!port) return undefined;
      ports.push(Number(port));
      continue;
    }
    if (/^-[nPt]+$/.test(text)) {
      terse ||= text.includes('t');
      continue;
    }
    return undefined;
  }
  return listen && terse && ports.length > 0 ? ports : undefined;
}

function filterOk(segment: Segment): { ok: boolean; listen: boolean; patterns: string[] } {
  const name = (segment.words[0]?.text ?? '').toLowerCase().replace(/\.exe$/, '');
  const args = segment.words.slice(1);
  const bad = { ok: false, listen: false, patterns: [] };
  if (!FILTERS.has(name) || segment.redirects.length > 0) return bad;
  if (name === 'awk')
    return {
      ok: args.length === 1 && AWK_PRINT.test(args[0]?.text ?? ''),
      listen: false,
      patterns: [],
    };
  if (name === 'head' || name === 'tail') {
    return { ok: args.every((arg) => COUNT_FLAG.test(arg.text)), listen: false, patterns: [] };
  }
  if (name === 'sort' || name === 'uniq') {
    return { ok: args.every((arg) => /^-[unr]+$/.test(arg.text)), listen: false, patterns: [] };
  }
  const patterns = args.filter((arg) => !GREP_FLAG.test(arg.text)).map((arg) => arg.text);
  // Второй не-ключ у `grep` — файл: вход уже не вывод netstat.
  if (patterns.length !== 1) return bad;
  // `|` вне группы портов — «или»: `':5173 |:9'` пропустит и чужие строки.
  if (patterns.some((text) => text.replace(PORT_GROUP, '').includes('|'))) return bad;
  return { ok: true, listen: patterns.some((text) => /LISTEN/i.test(text)), patterns };
}

/**
 * Порты, держателей которых напечатает подстановка, или `undefined` — это не
 * запрос держателей порта (или его вывод может оказаться шире их).
 */
export function portQueryPorts(text: string, loops: LoopValues): number[] | undefined {
  const body = substitutionBody(text);
  if (body === undefined) return undefined;
  const steps = parse(body);
  if (steps === UNPARSED) return undefined;
  const segments: Segment[] = [];
  for (const step of steps) {
    // Звено трубы обёрнуто входом и выходом; вслепую (`BLIND`) — не разбор.
    if (step === ENTER || step === LEAVE) continue;
    if (typeof step !== 'object') return undefined;
    segments.push(step);
  }
  const [first, ...rest] = segments;
  if (!first || first.redirects.length > 0 || first.inputs.length > 0) return undefined;
  if (rest.some((segment) => !segment.piped || segment.inputs.length > 0)) return undefined;
  const head = (first.words[0]?.text ?? '').toLowerCase().replace(/\.exe$/, '');
  let ports: number[] = [];
  let listen = false;
  if (head === 'lsof') {
    const found = lsofPorts(first.words.slice(1));
    if (!found) return undefined;
    ports = found;
    listen = true;
  } else if (head !== 'netstat' || !first.words.slice(1).every((w) => /^-[a-z]+$/i.test(w.text))) {
    return undefined;
  }
  for (const segment of rest) {
    const filter = filterOk(segment);
    if (!filter.ok) return undefined;
    listen ||= filter.listen;
    for (const pattern of filter.patterns) {
      const found = portsOfPattern(pattern, loops);
      if (!found) return undefined;
      ports.push(...found);
    }
  }
  return listen && ports.length > 0 ? [...new Set(ports)] : undefined;
}

/** Метка значения «номера держателей портов»: `<метка>5173,5174`. */
export function portMarkPorts(text: string, mark: string): number[] | undefined {
  if (!text.startsWith(mark)) return undefined;
  const ports = text.slice(mark.length).split(',').map(Number);
  return ports.length > 0 && ports.every((port) => Number.isInteger(port) && port > 0)
    ? ports
    : undefined;
}
