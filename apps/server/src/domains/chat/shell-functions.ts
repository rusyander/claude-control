/**
 * Функции оболочки из снимка CLI (повторная проверка 24.10, d): снимок Bash-
 * инструмента несёт не только псевдонимы, но и функции `.bashrc`, и вызов
 * `gsync` с телом `git fetch && git rebase origin/main` исполняет тело. Разбор
 * видел неизвестное имя `gsync` и пускал его правилами чата — тот же класс,
 * что псевдонимы. Здесь — только чтение тел; как их судить, решает разбор
 * (`group-command/alias-script.ts` `riskyFunctionBody`).
 *
 * Форматы снимка (CLI 2.1.310, `declare -f` каждой функции):
 * - `eval $'имя () \n{ \n    тело\n}' > /dev/null 2>&1` — `printf %q`, строка на функцию;
 * - `eval "$(echo '<base64>' | base64 -d)" > /dev/null 2>&1` — прежние версии;
 * - `имя () {` … `}` как есть — `typeset -f` у zsh.
 */

export type ShellFunctions = Readonly<Record<string, string>>;

/** `eval $'…'` с хвостом `> /dev/null 2>&1`. */
const EVAL_ANSI = /^eval\s+\$'((?:[^'\\]|\\.)*)'/;
/** `eval "$(echo '<base64>' | base64 -d)"`. */
const EVAL_BASE64 = /^eval\s+"\$\(echo\s+'([A-Za-z0-9+/=]+)'\s*\|\s*base64\s+(?:-d|--decode)\s*\)"/;
/** Заголовок `declare -f`: `имя () ` в начале строки; `{` той же строкой — у zsh. */
const HEADER = /^([^\s(){}=;&|<>'"$`\\]+)\s*\(\)\s*(\{.*)?$/;

/** Одна последовательность `\…` строки `$'…'` (`man bash`, QUOTING). */
const ANSI_ESCAPE =
  /\\(?:([abeEfnrtv\\'"?])|([0-7]{1,3})|x([0-9a-fA-F]{1,2})|u([0-9a-fA-F]{1,4})|U([0-9a-fA-F]{1,8})|c(.))/g;
const SIMPLE: Record<string, string> = {
  a: '\x07',
  b: '\b',
  e: '\x1b',
  E: '\x1b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  '\\': '\\',
  "'": "'",
  '"': '"',
  '?': '?',
};

/** Текст строки `$'…'` без кавычек. */
export function ansiCText(quoted: string): string {
  return quoted.replace(
    ANSI_ESCAPE,
    (
      _all,
      simple?: string,
      octal?: string,
      hex?: string,
      u4?: string,
      u8?: string,
      ctl?: string,
    ) => {
      if (simple !== undefined) return SIMPLE[simple] ?? simple;
      const code = octal
        ? parseInt(octal, 8)
        : parseInt(hex ?? u4 ?? u8 ?? '', 16) || (ctl ? ctl.charCodeAt(0) & 0x1f : 0);
      return String.fromCodePoint(Math.min(code, 0x10ffff));
    },
  );
}

/**
 * Определения в виде `declare -f`: имя и тело между `{` заголовка (той же или
 * следующей строкой) и `}` в начале строки. Закрывающей нет — тело до конца
 * текста: лишний текст тела только строже.
 */
function definitions(text: string, into: Record<string, string>): void {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const head = HEADER.exec((lines[i] as string).trimEnd());
    if (!head) continue;
    const name = head[1] as string;
    const inline = head[2];
    // `имя() { тело; }` одной строкой.
    if (inline !== undefined && /\}\s*$/.test(inline)) {
      into[name] = inline
        .replace(/^\{\s*/, '')
        .replace(/\}\s*$/, '')
        .trim();
      continue;
    }
    const body: string[] = [];
    let j = i + 1;
    if (inline !== undefined) body.push(inline.replace(/^\{\s*/, ''));
    else if ((lines[j] ?? '').trim().startsWith('{')) {
      body.push((lines[j] as string).trim().replace(/^\{\s*/, ''));
      j += 1;
    }
    for (; j < lines.length && (lines[j] as string).trimEnd() !== '}'; j += 1) {
      body.push(lines[j] as string);
    }
    into[name] = body.join('\n').trim();
    i = j;
  }
}

/** Функции из текста снимка: строки `eval …` по одной и определения как есть. */
export function parseFunctions(text: string): ShellFunctions {
  // Без прототипа: имя `constructor` — такая же функция, как прочие.
  const functions: Record<string, string> = Object.create(null) as Record<string, string>;
  const plain: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const ansi = EVAL_ANSI.exec(line.trim());
    const encoded = ansi ? undefined : EVAL_BASE64.exec(line.trim());
    if (ansi) definitions(ansiCText(ansi[1] as string), functions);
    else if (encoded) {
      definitions(Buffer.from(encoded[1] as string, 'base64').toString('utf8'), functions);
    } else plain.push(line);
  }
  definitions(plain.join('\n'), functions);
  return functions;
}
