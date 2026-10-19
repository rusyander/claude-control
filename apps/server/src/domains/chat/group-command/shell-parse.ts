/**
 * Звенья команды оболочки с кавычками и комментарием — как их видит оболочка.
 * Разбор нужен `group-command.ts`: регулярки по тексту путали слова сообщения
 * коммита с командой и не узнавали составную `cd … && git push … | tail`.
 */

export interface Word {
  text: string;
  /** В слове подстановка (`$x`, `$(…)`, `` `…` ``): что в нём будет — неизвестно. */
  dynamic: boolean;
}

export interface Segment {
  words: Word[];
  /** Перенаправления звена как записаны: `2>&1`, `>/dev/null`. */
  redirects: string[];
}

/** Команда не разобрана надёжно: подоболочка, heredoc, незакрытая кавычка. */
export const UNPARSED = Symbol('unparsed');

const OPERATORS = ['&&', '||', '|', ';', '\n', '&'];

export function parse(command: string): Segment[] | typeof UNPARSED {
  const segments: Segment[] = [];
  let current: Segment = { words: [], redirects: [] };
  let word: Word | undefined;
  const flush = (): void => {
    if (!word) return;
    const redirect = /^(\d*|&)>>?(&\d+|\S+)?$|^\d*<\S*$/.exec(word.text);
    if (redirect && !word.dynamic) current.redirects.push(word.text);
    else current.words.push(word);
    word = undefined;
  };
  const cut = (): void => {
    flush();
    if (current.words.length > 0 || current.redirects.length > 0) segments.push(current);
    current = { words: [], redirects: [] };
  };
  const start = (): Word => (word ??= { text: '', dynamic: false });

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i] as string;
    if (ch === '#' && !word) {
      // Комментарий до конца строки: `… | tail -5 # sieve-ack: …`.
      while (i < command.length && command[i] !== '\n') i += 1;
      i -= 1;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      flush();
      continue;
    }
    if (ch === '\\' && command[i + 1] === '\n') {
      i += 1;
      flush();
      continue;
    }
    const operator = OPERATORS.find((op) => command.startsWith(op, i));
    // `2>&1` и `&>` — перенаправление, а не фон и не разделитель.
    const inRedirect = word && /^(\d*|&)?>$/.test(word.text);
    if (operator && !(operator === '&' && (inRedirect || command[i + 1] === '>'))) {
      if (operator === '&' && command[i + 1] !== '&') return UNPARSED;
      cut();
      i += operator.length - 1;
      continue;
    }
    if ('(){}'.includes(ch) || command.startsWith('<<', i) || command.startsWith('<(', i)) {
      return UNPARSED;
    }
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) return UNPARSED;
      start().text += command.slice(i + 1, end);
      i = end;
      continue;
    }
    if (ch === '"') {
      const w = start();
      let j = i + 1;
      for (; j < command.length && command[j] !== '"'; j += 1) {
        // В двойных кавычках `\` экранирует только `$`, `` ` ``, `"`, `\`; прочее —
        // буквально: `"C:\Users\…"` — путь Windows, а не `C:Users…`.
        if (command[j] === '\\' && '$`"\\'.includes(command[j + 1] ?? '')) {
          j += 1;
          w.text += command[j];
          continue;
        }
        if (command[j] === '$' || command[j] === '`') w.dynamic = true;
        w.text += command[j];
      }
      if (j >= command.length) return UNPARSED;
      i = j;
      continue;
    }
    if (ch === '`' || (ch === '$' && command[i + 1] === '(')) return UNPARSED;
    if (ch === '$' || ch === '~' || ch === '\\' || ch === '%') start().dynamic = true;
    start().text += ch;
  }
  cut();
  return segments;
}
