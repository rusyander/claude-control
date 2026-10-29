import type { ParsedCommand, ParsedScript, Stdin } from './exec-argv.types.ts';
import { hole, PROCESS_SUBSTITUTION, variable } from './marks.ts';

/**
 * Строка POSIX-оболочки → простые команды (core-s2 F-02). Разбор как у bash: `\` снимает
 * экранирование с любого знака, `\`+перевод строки склеивает строку, `$'…'` раскрывает escape,
 * `$"…"` — двойные кавычки; `;`, `&`, `|`, `(`, `)`, перевод строки разрывают команду;
 * `<`, `>` — перенаправления (цель — не слово команды); here-doc и here-string — вход команды.
 * Переменная — дыра с именем, маска, раскрытие скобок, подстановка — дыра без имени (`marks.ts`).
 *
 * `lenient` — второе чтение для путей Windows: `\` экранирует только пробел, кавычки, `$`,
 * `` ` ``, `\` и управляющие знаки, так `C:\x\git.exe` остаётся путём. Судья смотрит оба.
 * Разбор тотальный: незакрытая кавычка или подстановка забирает остаток строки.
 */

export type BashMode = 'bash' | 'lenient';

const LENIENT_ESCAPABLE = new Set([' ', '\t', '"', "'", '\\', '$', '`', ';', '&', '|', '(', ')']);
const IN_DOUBLE_ESCAPABLE = new Set(['"', '\\', '$', '`']);
const SPECIAL_PARAM = /^[0-9@*#?$!-]$/;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*/;

/** Конец `$(…)` / `<(…)` с учётом вложенных скобок и кавычек; нет конца — до конца строки. */
export function substitutionEnd(text: string, from: number): number {
  let depth = 1;
  let quote: '"' | "'" | null = null;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"') i++;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '\\') i++;
    else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return i;
  }
  return text.length;
}

/** Конец `${…}` с учётом вложенности; нет конца — до конца строки. */
function braceEnd(text: string, from: number): number {
  let depth = 1;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') i++;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  return text.length;
}

function backtickEnd(text: string, from: number): number {
  let end = from;
  while (end < text.length && text[end] !== '`') end += text[end] === '\\' ? 2 : 1;
  return Math.min(end, text.length);
}

/** `$'…'`: escape-последовательности bash. Байты меток (`\0`, `\1`) выбрасываются. */
function ansiC(text: string, from: number): { value: string; end: number } {
  let value = '';
  let i = from;
  const simple: Record<string, string> = {
    n: '\n',
    t: '\t',
    r: '\r',
    a: '\x07',
    b: '\b',
    e: '\x1b',
    E: '\x1b',
    f: '\f',
    v: '\v',
    '\\': '\\',
    "'": "'",
    '"': '"',
    '?': '?',
  };
  for (; i < text.length; i++) {
    const ch = text[i] as string;
    if (ch === "'") break;
    if (ch !== '\\') {
      value += ch;
      continue;
    }
    const next = text[i + 1] ?? '';
    const known = simple[next];
    if (known !== undefined) {
      value += known;
      i++;
      continue;
    }
    const hex = /^x([0-9a-fA-F]{1,2})/.exec(text.slice(i + 1));
    const uni = /^[uU]([0-9a-fA-F]{1,8})/.exec(text.slice(i + 1));
    const oct = /^([0-7]{1,3})/.exec(text.slice(i + 1));
    const ctl = /^c(.)/.exec(text.slice(i + 1));
    if (hex) {
      value += String.fromCharCode(parseInt(hex[1] as string, 16));
      i += hex[0].length;
    } else if (uni) {
      const code = parseInt(uni[1] as string, 16);
      value += code <= 0x10ffff ? String.fromCodePoint(code) : '';
      i += uni[0].length;
    } else if (oct) {
      value += String.fromCharCode(parseInt(oct[1] as string, 8) & 0xff);
      i += oct[0].length;
    } else if (ctl) {
      value += String.fromCharCode((ctl[1] as string).charCodeAt(0) & 0x1f);
      i += 2;
    } else {
      value += `\\${next}`;
      i++;
    }
  }
  // eslint-disable-next-line no-control-regex -- метки дыр и есть управляющие знаки \0 и \1
  return { value: value.replace(/[\u0000\u0001]/g, ''), end: i };
}

/** Подстановки в тексте, где кавычки ничего не значат (тело here-doc без кавычек). */
export function expansionsIn(text: string): string[] {
  const subs: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') i++;
    else if (ch === '$' && text[i + 1] === '(') {
      const end = substitutionEnd(text, i + 2);
      subs.push(text.slice(i + 2, end));
      i = end;
    } else if (ch === '$' && text[i + 1] === '{') {
      const end = braceEnd(text, i + 2);
      subs.push(...parseBash(text.slice(i + 2, end)).substitutions);
      i = end;
    } else if (ch === '`') {
      const end = backtickEnd(text, i + 1);
      subs.push(text.slice(i + 1, end).replace(/\\`/g, '`'));
      i = end;
    }
  }
  return subs;
}

interface Heredoc {
  delim: string;
  quoted: boolean;
  dash: boolean;
  target: ParsedCommand;
}

type Pending = 'file' | 'herestring' | 'heredoc' | 'heredoc-dash' | null;

export function parseBash(text: string, mode: BashMode = 'bash'): ParsedScript {
  const commands: ParsedCommand[] = [];
  const substitutions: string[] = [];
  const unknown: string[] = [];
  let current: ParsedCommand = { words: [], redirects: [] };
  let nextStdin: Stdin | undefined;
  let word = '';
  let inWord = false;
  let quoted = false;
  let quote: '"' | "'" | null = null;
  let braceOpen = 0;
  let braceSep = false;
  let braceExp = false;
  let pending: Pending = null;
  const heredocs: Heredoc[] = [];
  // `case … in`: слова до `)` — образцы, не команда.
  let caseDepth = 0;
  let pattern = false;

  const resetWord = () => {
    word = '';
    inWord = false;
    quoted = false;
    braceOpen = 0;
    braceSep = false;
    braceExp = false;
  };
  const endWord = () => {
    if (!inWord) return;
    const value = braceExp ? hole() : word;
    const first = current.words.length === 0;
    if (pending === 'file') current.redirects.push(value);
    else if (pending === 'herestring') current.stdin = { kind: 'text', text: value };
    else if (pending === 'heredoc' || pending === 'heredoc-dash') {
      heredocs.push({ delim: value, quoted, dash: pending === 'heredoc-dash', target: current });
    } else if (pattern) {
      // Образец ветки `case` — не слово команды; `esac` закрывает `case`.
      if (value === 'esac' && !quoted) {
        caseDepth = Math.max(0, caseDepth - 1);
        pattern = false;
      }
    } else {
      current.words.push(value);
      if (first && value === 'case') caseDepth++;
      if (first && value === 'esac' && caseDepth > 0) caseDepth--;
      if (caseDepth > 0 && current.words[0] === 'case' && value === 'in') {
        pending = null;
        resetWord();
        endCommand();
        pattern = true;
        return;
      }
    }
    pending = null;
    resetWord();
  };
  const endCommand = (pipe = false) => {
    endWord();
    pending = null;
    if (current.words.length || current.redirects.length || current.stdin) {
      if (!current.stdin && nextStdin) current.stdin = nextStdin;
      commands.push(current);
      nextStdin = undefined;
    }
    current = { words: [], redirects: [] };
    if (pipe) nextStdin = { kind: 'pipe' };
  };
  const readHeredocs = (from: number): number => {
    let at = from;
    while (heredocs.length) {
      const doc = heredocs.shift() as Heredoc;
      const lines: string[] = [];
      for (;;) {
        if (at >= text.length) break;
        const nl = text.indexOf('\n', at);
        const raw = text.slice(at, nl < 0 ? text.length : nl).replace(/\r$/, '');
        at = nl < 0 ? text.length : nl + 1;
        const line = doc.dash ? raw.replace(/^\t+/, '') : raw;
        if (line === doc.delim) break;
        lines.push(line);
      }
      const body = lines.join('\n');
      if (!doc.quoted) substitutions.push(...expansionsIn(body));
      doc.target.stdin = { kind: 'text', text: body };
    }
    return at - 1;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    const next = text[i + 1];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else word += ch;
      continue;
    }
    if (!quote && ch === '$' && next === "'") {
      const { value, end } = ansiC(text, i + 2);
      word += value;
      inWord = true;
      quoted = true;
      i = end;
      continue;
    }
    if (!quote && ch === '$' && next === '"') {
      quote = '"';
      inWord = true;
      quoted = true;
      i++;
      continue;
    }
    if (ch === '\\') {
      if (next === '\n') {
        i++;
        continue;
      }
      if (next === '\r' && text[i + 2] === '\n') {
        i += 2;
        continue;
      }
      const escapes =
        next !== undefined &&
        (quote === '"'
          ? IN_DOUBLE_ESCAPABLE.has(next)
          : mode === 'bash' || LENIENT_ESCAPABLE.has(next));
      if (escapes) {
        word += next;
        inWord = true;
        quoted = true;
        i++;
      } else {
        word += ch;
        inWord = true;
      }
      continue;
    }
    if (ch === '$') {
      inWord = true;
      if (next === '(') {
        const end = substitutionEnd(text, i + 2);
        substitutions.push(text.slice(i + 2, end));
        word += hole();
        i = end;
        continue;
      }
      if (next === '{') {
        const end = braceEnd(text, i + 2);
        const inner = text.slice(i + 2, end);
        const name = /^[A-Za-z_][A-Za-z0-9_]*$/.test(inner) ? inner : null;
        if (!name) substitutions.push(...parseBash(inner, mode).substitutions);
        word += name ? variable(name) : hole();
        i = end;
        continue;
      }
      const named = NAME.exec(text.slice(i + 1));
      if (named) {
        word += variable(named[0]);
        i += named[0].length;
        continue;
      }
      if (next !== undefined && SPECIAL_PARAM.test(next)) {
        word += hole();
        i++;
        continue;
      }
      word += ch;
      continue;
    }
    if (ch === '`') {
      const end = backtickEnd(text, i + 1);
      substitutions.push(text.slice(i + 1, end).replace(/\\`/g, '`'));
      word += hole();
      inWord = true;
      i = end;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else word += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
      quoted = true;
    } else if (ch === '#' && !inWord) {
      while (i + 1 < text.length && text[i + 1] !== '\n') i++;
    } else if ((ch === '<' || ch === '>') && next === '(') {
      const end = substitutionEnd(text, i + 2);
      substitutions.push(text.slice(i + 2, end));
      word += PROCESS_SUBSTITUTION;
      inWord = true;
      i = end;
    } else if (ch === '<' || ch === '>' || (ch === '&' && next === '>')) {
      // Номер дескриптора перед `>` (`2>`) — не слово команды.
      if (inWord && !quoted && /^(\d+|\{[A-Za-z_]\w*\})$/.test(word)) resetWord();
      else endWord();
      let op = ch;
      while ('<>&|-'.includes(text[i + 1] ?? '') && op.length < 3) {
        const c = text[i + 1] as string;
        if (c === '-' && op !== '<<') break;
        op += c;
        i++;
      }
      if (op === '<<<') pending = 'herestring';
      else if (op === '<<-') pending = 'heredoc-dash';
      else if (op === '<<') pending = 'heredoc';
      else pending = 'file';
    } else if (ch === '&') {
      endCommand();
      if (next === '&') i++;
    } else if (ch === '|') {
      if (pattern) {
        endWord();
        continue;
      }
      if (next === '|') {
        endCommand();
        i++;
      } else {
        endCommand(true);
        if (next === '&') i++;
      }
    } else if (ch === ';') {
      endCommand();
      if (caseDepth > 0 && (next === ';' || next === '&')) {
        pattern = true;
        i++;
        if (text[i + 1] === '&') i++;
      }
    } else if (ch === '(') {
      if (inWord && !quoted && /[@!+*?]$/.test(word)) {
        // extglob `@(…)`, `!(…)`: маска, значение неизвестно.
        const end = substitutionEnd(text, i + 1);
        word += hole();
        i = end;
      } else if (pattern) {
        endWord();
      } else endCommand();
    } else if (ch === ')') {
      if (pattern) {
        resetWord();
        current = { words: [], redirects: [] };
        pattern = false;
      } else endCommand();
    } else if (ch === '\n') {
      endCommand();
      if (heredocs.length) i = readHeredocs(i + 1);
    } else if (ch === '\r') {
      endCommand();
    } else if (ch === ' ' || ch === '\t') {
      endWord();
    } else if (ch === '*' || ch === '?') {
      word += hole();
      inWord = true;
    } else if (ch === '[' && globClassEnd(text, i) > 0) {
      word += hole();
      inWord = true;
      i = globClassEnd(text, i);
    } else {
      if (ch === '{') braceOpen++;
      else if (braceOpen > 0 && (ch === ',' || (ch === '.' && next === '.'))) braceSep = true;
      else if (ch === '}' && braceOpen > 0) {
        braceOpen--;
        if (braceSep) braceExp = true;
      }
      word += ch;
      inWord = true;
    }
  }
  endCommand();
  return { chains: commands.map((c) => c.words), commands, substitutions, unknown };
}

/** `[…]` — класс маски, если `]` есть в том же слове; иначе `[` — просто знак (`[ -f x ]`). */
function globClassEnd(text: string, from: number): number {
  for (let i = from + 1; i < text.length; i++) {
    const ch = text[i] as string;
    if (ch === ']' && i > from + 1) return i;
    if (' \t\n\r;&|()<>'.includes(ch)) return -1;
  }
  return -1;
}
