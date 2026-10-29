import type { ParsedCommand, ParsedScript, Stdin } from './exec-argv.types.ts';
import { hole, variable } from './marks.ts';

/**
 * Строки cmd.exe и PowerShell (core-s2 F-03). На Windows команду исполняет не bash: Qwen
 * зовёт оболочку системы, у Claude есть инструмент PowerShell. Здесь — их правила слов:
 * cmd — `^` экранирует, `%VAR%` — переменная, `&`, `|`, `(`, `)` разрывают команду; PowerShell —
 * `` ` `` экранирует, `'…'` дословно, `$x`, `$(…)`, `@args` — дыры и подстановки, `{ }` —
 * блок, тело которого исполнится. Вызов значения, собранного на лету (`& (…)`, `iex` с
 * выражением, `[scriptblock]::Create`), разобрать нельзя — это `unknown`.
 */

class Builder {
  commands: ParsedCommand[] = [];
  substitutions: string[] = [];
  unknown: string[] = [];
  current: ParsedCommand = { words: [], redirects: [] };
  nextStdin: Stdin | undefined;
  word = '';
  inWord = false;
  redirect = false;

  endWord(): void {
    if (!this.inWord) return;
    if (this.redirect) this.current.redirects.push(this.word);
    else this.current.words.push(this.word);
    this.redirect = false;
    this.word = '';
    this.inWord = false;
  }

  endCommand(pipe = false): void {
    this.endWord();
    this.redirect = false;
    const c = this.current;
    if (c.words.length || c.redirects.length) {
      if (this.nextStdin) c.stdin = this.nextStdin;
      this.commands.push(c);
      this.nextStdin = undefined;
    }
    this.current = { words: [], redirects: [] };
    if (pipe) this.nextStdin = { kind: 'pipe' };
  }

  add(text: string): void {
    this.word += text;
    this.inWord = true;
  }

  done(): ParsedScript {
    this.endCommand();
    return {
      chains: this.commands.map((c) => c.words),
      commands: this.commands,
      substitutions: this.substitutions,
      unknown: this.unknown,
    };
  }
}

/** Строка cmd.exe. Кавычки cmd оставляет программе — здесь они сняты, как их снимет CRT. */
export function parseCmd(text: string): ParsedScript {
  const b = new Builder();
  let quote = false;
  let block = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    const next = text[i + 1];
    if (ch === '%') {
      const end = text.indexOf('%', i + 1);
      const name = end > i ? text.slice(i + 1, end) : '';
      if (name && !/[\r\n]/.test(name)) {
        b.add(/^[~\w]/.test(name) && !/^\d/.test(name) ? variable(name.toUpperCase()) : hole());
        i = end;
        continue;
      }
      if (/^[0-9*~]/.test(next ?? '')) {
        b.add(hole());
        i++;
        continue;
      }
    }
    if (quote) {
      if (ch === '"') quote = false;
      else b.add(ch);
      continue;
    }
    if (ch === '^') {
      if (next === '\n' || next === '\r') {
        i += next === '\r' && text[i + 2] === '\n' ? 2 : 1;
        continue;
      }
      if (next !== undefined) b.add(next);
      i++;
    } else if (ch === '"') {
      quote = true;
      b.inWord = true;
    } else if (ch === '(' && !b.inWord && b.current.words.length === 0) {
      // Блок `( … )` открывается только на месте команды; в аргументах `(` — буква.
      b.endCommand();
      block++;
    } else if (ch === ')' && block > 0) {
      b.endCommand();
      block--;
    } else if (ch === '&' || ch === '\n' || ch === '\r') {
      b.endCommand();
      if (ch === '&' && next === '&') i++;
    } else if (ch === '|') {
      if (next === '|') {
        b.endCommand();
        i++;
      } else b.endCommand(true);
    } else if (ch === '<' || ch === '>') {
      if (b.inWord && /^\d$/.test(b.word)) {
        b.word = '';
        b.inWord = false;
      } else b.endWord();
      while (text[i + 1] === '>' || text[i + 1] === '&') i++;
      b.redirect = true;
    } else if (ch === ' ' || ch === '\t') {
      b.endWord();
    } else if (ch === '@' && !b.inWord && b.current.words.length === 0) {
      // `@` перед командой гасит эхо и ничего не меняет.
    } else b.add(ch);
  }
  return b.done();
}

/** Конец `(…)` / `{…}` PowerShell с учётом вложенности и кавычек. */
function groupEnd(text: string, from: number, open: string, close: string): number {
  let depth = 1;
  let quote: string | null = null;
  for (let i = from; i < text.length; i++) {
    const ch = text[i] as string;
    if (quote) {
      if (ch === '`') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '`') i++;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) return i;
  }
  return text.length;
}

const PS_ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', a: '\x07', f: '\f' };
const PS_VAR = /^(?:[A-Za-z_][\w]*:)?[A-Za-z_?][\w]*/;
const PS_DYNAMIC =
  /\[\s*scriptblock\s*\]|::\s*create\s*\(|\.invoke\s*\(|invokecommand|newscriptblock/i;

/** `$…` PowerShell: переменная — дыра с именем, `$(…)` — подстановка. Возвращает новый индекс. */
function psDollar(b: Builder, text: string, i: number): number {
  const next = text[i + 1];
  if (next === '(') {
    const end = groupEnd(text, i + 2, '(', ')');
    b.substitutions.push(text.slice(i + 2, end));
    b.add(hole());
    return end;
  }
  if (next === '{') {
    const end = text.indexOf('}', i + 2);
    const stop = end < 0 ? text.length : end;
    b.add(variable(text.slice(i + 2, stop).toLowerCase()));
    return stop;
  }
  const named = PS_VAR.exec(text.slice(i + 1));
  if (named) {
    b.add(variable(named[0].toLowerCase()));
    return i + named[0].length;
  }
  b.add('$');
  return i;
}

export function parsePowerShell(text: string): ParsedScript {
  const b = new Builder();
  if (PS_DYNAMIC.test(text)) b.unknown.push('PowerShell builds a script block at run time');
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    const next = text[i + 1];
    if (quote === "'") {
      if (ch === "'" && next === "'") {
        b.add("'");
        i++;
      } else if (ch === "'") quote = null;
      else b.add(ch);
      continue;
    }
    if (quote === '"') {
      if (ch === '`' && next !== undefined) {
        b.add(PS_ESCAPES[next] ?? next);
        i++;
      } else if (ch === '"' && next === '"') {
        b.add('"');
        i++;
      } else if (ch === '"') quote = null;
      else if (ch === '$') i = psDollar(b, text, i);
      else b.add(ch);
      continue;
    }
    const atStart = !b.inWord && b.current.words.length === 0;
    if (ch === '`') {
      if (next === '\n' || next === '\r') {
        i += next === '\r' && text[i + 2] === '\n' ? 2 : 1;
        continue;
      }
      if (next !== undefined) b.add(next);
      i++;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      b.inWord = true;
    } else if (
      ch === '@' &&
      (next === "'" || next === '"') &&
      /^[ \t]*\r?\n/.test(text.slice(i + 2))
    ) {
      // here-string `@'…'@` / `@"…"@`: текст до строки с закрывающей парой.
      const close = `\n${next}@`;
      const end = text.indexOf(close, i + 2);
      const body = text.slice(text.indexOf('\n', i + 2) + 1, end < 0 ? text.length : end);
      b.add(body);
      if (next === '"') b.substitutions.push(...dollarGroups(body));
      i = end < 0 ? text.length : end + close.length - 1;
    } else if (ch === '$') {
      i = psDollar(b, text, i);
    } else if (ch === '@' && next === '(') {
      const end = groupEnd(text, i + 2, '(', ')');
      b.substitutions.push(text.slice(i + 2, end));
      b.add(hole());
      i = end;
    } else if (ch === '@' && /[A-Za-z_]/.test(next ?? '')) {
      // Сплаттинг `@args` — неизвестный набор слов.
      const named = PS_VAR.exec(text.slice(i + 1));
      b.add(hole());
      i += named ? named[0].length : 0;
    } else if (ch === '#' && !b.inWord) {
      while (i + 1 < text.length && text[i + 1] !== '\n') i++;
    } else if (ch === '<' && next === '#') {
      const end = text.indexOf('#>', i + 2);
      i = end < 0 ? text.length : end + 1;
    } else if ((ch === '&' || ch === '.') && atStart && /^[ \t]*[(]/.test(text.slice(i + 1))) {
      b.unknown.push(`call operator ${ch} on a computed value`);
    } else if (ch === '&' || ch === ';' || ch === '\n' || ch === '\r' || '(){}'.includes(ch)) {
      b.endCommand();
      if (ch === '&' && next === '&') i++;
    } else if (ch === '|') {
      if (next === '|') {
        b.endCommand();
        i++;
      } else b.endCommand(true);
    } else if (ch === '>' || (ch === '<' && b.inWord === false)) {
      if (b.inWord && /^(\d|\*)$/.test(b.word)) {
        b.word = '';
        b.inWord = false;
      } else b.endWord();
      while (text[i + 1] === '>' || text[i + 1] === '&') i++;
      if (/^\d/.test(text[i + 1] ?? '') && text[i] === '&') i++;
      else b.redirect = true;
    } else if (ch === ' ' || ch === '\t' || ch === ',') {
      b.endWord();
    } else if (ch === '.' && atStart && (next === ' ' || next === '\t')) {
      // dot-source `. cmd` исполняет cmd, как `&`.
    } else b.add(ch);
  }
  const parsed = b.done();
  // `$x = 'git'` — присваивание: обход подставит значение в `& $x push`.
  for (const c of parsed.commands) {
    // eslint-disable-next-line no-control-regex -- метки дыр и есть управляющие знаки \0 и \1
    const m = /^\u0000\$([^\u0001]+)\u0001(=(.*))?$/s.exec(c.words[0] ?? '');
    if (!m) continue;
    if (m[2] !== undefined) c.words.splice(0, 1, `${m[1]}=${m[3]}`);
    else if (c.words[1] === '=') c.words.splice(0, 3, `${m[1]}=${c.words[2] ?? ''}`);
  }
  return parsed;
}

function dollarGroups(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '$' && text[i + 1] === '(') {
      const end = groupEnd(text, i + 2, '(', ')');
      out.push(text.slice(i + 2, end));
      i = end;
    }
  }
  return out;
}
