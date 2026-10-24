/**
 * Команда с раскрытыми псевдонимами снимка оболочки — ТЕКСТОМ, с теми же
 * кавычками, перенаправлениями и составными формами (повторная проверка 24.10,
 * a). Разбор (`group-command.ts` + `alias-script.ts`) раскрывает псевдоним по
 * словам; сверка догона целевой ветки (`main-sync.ts`) читает текст, и `grb
 * origin/main` при `alias grb='git rebase'` шёл мимо неё рутиной без конфликта.
 *
 * Правила те же, что у Bash и у разбора: раскрывается неэкранированное слово в
 * позиции команды (начало, после `;` `&&` `||` `|` `&` `(` `$(` `` ` ``, после
 * `if`/`then`/`do`/`{`/`!` и присваиваний), значение кончается пробелом —
 * раскрывается и следующее слово; имя не раскрывается внутри своей же
 * развёртки. `eval` исполняет текст в той же оболочке — его аргумент раскрывается
 * тоже. Тела heredoc — данные, их текст не трогается.
 */

type Aliases = Readonly<Record<string, string>>;

/** После этих слов снова позиция команды. */
const OPENS = new Set(['if', 'then', 'else', 'elif', 'while', 'until', 'do', '{', '!', 'time']);
/** Конец слова без кавычек. */
const WORD_END = /[\s;&|()<>`]/;
/** Слово — буквальный текст без кавычек, экранирования и подстановок. */
const LITERAL = /^[^'"\\$`]+$/;
const ASSIGNMENT = /^[A-Za-z_]\w*\+?=/;

interface Scan {
  text: string;
  /** Следующее слово — в позиции команды. */
  command: boolean;
}

/** Конец `$( … )` с учётом вложенных скобок и кавычек: индекс закрывающей `)`. */
function closeParen(text: string, from: number): number {
  let depth = 1;
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\\') i += 1;
    else if (ch === "'") i = Math.max(i, text.indexOf("'", i + 1));
    else if (ch === '(') depth += 1;
    else if (ch === ')' && (depth -= 1) === 0) return i;
  }
  return text.length;
}

/** Конец `` `…` ``: индекс закрывающей обратной кавычки. */
function closeTick(text: string, from: number): number {
  for (let i = from; i < text.length; i += 1) {
    if (text[i] === '\\') i += 1;
    else if (text[i] === '`') return i;
  }
  return text.length;
}

class AliasText {
  // Без свойств-параметров конструктора: сервер идёт с `--experimental-strip-types`.
  private readonly aliases: Aliases;
  private readonly expanding: ReadonlySet<string>;

  constructor(aliases: Aliases, expanding: ReadonlySet<string>) {
    this.aliases = aliases;
    this.expanding = expanding;
  }

  /** Подстановка `$(…)` или `` `…` `` с позиции `at`: её текст раскрыт как команда. */
  private substitution(text: string, at: number): { out: string; next: number } {
    if (text[at] === '`') {
      const end = closeTick(text, at + 1);
      return { out: `\`${this.scan(text.slice(at + 1, end)).text}\``, next: end + 1 };
    }
    const end = closeParen(text, at + 2);
    return { out: `$(${this.scan(text.slice(at + 2, end)).text})`, next: end + 1 };
  }

  /** Слово с позиции `at`: кавычки как есть, подстановки внутри раскрыты. */
  private word(text: string, at: number): { out: string; raw: string; next: number } {
    let out = '';
    let i = at;
    while (i < text.length && !WORD_END.test(text[i] as string)) {
      const ch = text[i] as string;
      if (ch === '\\') {
        out += text.slice(i, i + 2);
        i += 2;
      } else if (ch === "'") {
        const end = text.indexOf("'", i + 1);
        const stop = end < 0 ? text.length : end + 1;
        out += text.slice(i, stop);
        i = stop;
      } else if (ch === '"') {
        let j = i + 1;
        out += '"';
        while (j < text.length && text[j] !== '"') {
          if (text[j] === '\\') {
            out += text.slice(j, j + 2);
            j += 2;
          } else if (text.startsWith('$(', j) || text[j] === '`') {
            const sub = this.substitution(text, j);
            out += sub.out;
            j = sub.next;
          } else {
            out += text[j];
            j += 1;
          }
        }
        out += j < text.length ? '"' : '';
        i = j + 1;
      } else if (text.startsWith('$(', i)) {
        const sub = this.substitution(text, i);
        out += sub.out;
        i = sub.next;
      } else {
        out += ch;
        i += 1;
      }
    }
    return { out, raw: text.slice(at, i), next: i };
  }

  /** Развёртка псевдонима `name` в позиции команды. */
  private alias(name: string): Scan {
    const value = this.aliases[name] as string;
    const inner = new AliasText(this.aliases, new Set([...this.expanding, name])).scan(value);
    return { text: inner.text, command: /[ \t]$/.test(value) || inner.command };
  }

  /** Аргумент `eval` целиком в кавычках — текст, который оболочка исполнит. */
  private evalArgument(raw: string): string | undefined {
    const quoted = /^'([^']*)'$/.exec(raw) ?? /^"([^"\\$`]*)"$/.exec(raw);
    if (!quoted) return undefined;
    const inner = quoted[1] as string;
    const text = this.scan(inner).text;
    if (text === inner) return raw;
    const mark = raw[0] as string;
    return text.includes(mark) ? text : `${mark}${text}${mark}`;
  }

  scan(text: string): Scan {
    let out = '';
    let command = true;
    let evalNext = false;
    const heredocs: { delimiter: string; tabs: boolean }[] = [];
    let i = 0;
    while (i < text.length) {
      const ch = text[i] as string;
      if (ch === ' ' || ch === '\t') {
        out += ch;
        i += 1;
      } else if (ch === '\n') {
        out += ch;
        i += 1;
        command = true;
        evalNext = false;
        // Тела heredoc — данные: до строки-разделителя как есть.
        for (const { delimiter, tabs } of heredocs.splice(0)) {
          while (i < text.length) {
            const end = text.indexOf('\n', i);
            const line = text.slice(i, end < 0 ? text.length : end);
            out += text.slice(i, end < 0 ? text.length : end + 1);
            i = end < 0 ? text.length : end + 1;
            if ((tabs ? line.replace(/^\t+/, '') : line) === delimiter) break;
          }
        }
      } else if (ch === '#' && (i === 0 || /\s/.test(text[i - 1] as string))) {
        const end = text.indexOf('\n', i);
        out += text.slice(i, end < 0 ? text.length : end);
        i = end < 0 ? text.length : end;
      } else if (ch === '<' || ch === '>') {
        // Перенаправление: цель — не команда, позиция команды не меняется.
        const op = /^(?:<<<|<<-?|[<>]{1,2}[&|]?|<>)/.exec(text.slice(i))?.[0] ?? ch;
        out += op;
        i += op.length;
        if (text[i] === '(') {
          // `<(…)`, `>(…)` — подстановка процесса: внутри команда.
          const end = closeParen(text, i + 1);
          out += `(${this.scan(text.slice(i + 1, end)).text})`;
          i = end + 1;
          continue;
        }
        while (text[i] === ' ' || text[i] === '\t') out += text[i++];
        const target = this.word(text, i);
        out += target.out;
        i = target.next;
        if (op === '<<' || op === '<<-') {
          heredocs.push({ delimiter: target.raw.replace(/['"\\]/g, ''), tabs: op === '<<-' });
        }
      } else if (/[;&|()`]/.test(ch)) {
        out += ch;
        i += 1;
        command = true;
        evalNext = false;
      } else {
        const word = this.word(text, i);
        i = word.next;
        const literal = LITERAL.test(word.raw);
        const evaluated: string | undefined = evalNext ? this.evalArgument(word.raw) : undefined;
        if (evaluated !== undefined) {
          out += evaluated;
          command = false;
        } else if (command && literal && ASSIGNMENT.test(word.raw)) {
          out += word.out;
        } else if (
          command &&
          literal &&
          !this.expanding.has(word.raw) &&
          Object.hasOwn(this.aliases, word.raw)
        ) {
          const expanded = this.alias(word.raw);
          out += expanded.text;
          command = expanded.command;
        } else {
          out += word.out;
          command = (command && literal && OPENS.has(word.raw)) || (command && word.raw === 'eval');
        }
        evalNext = evaluated === undefined && word.raw === 'eval' && command;
      }
    }
    return { text: out, command };
  }
}

/** Текст команды с раскрытыми псевдонимами (`undefined`/пусто — как написано). */
export function expandAliasText(command: string, aliases: Aliases | undefined): string {
  if (!aliases || Object.keys(aliases).length === 0) return command;
  return new AliasText(aliases, new Set()).scan(command).text;
}
