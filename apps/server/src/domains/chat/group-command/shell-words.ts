/**
 * Чтение слов команды оболочки: кавычки, `$…`, `` `…` ``, перенаправления и
 * тела heredoc. Вынесено из `shell-parse.ts` по размеру; разбор списка команд
 * (`Parser.list`) — там, подстановки он судит через `list` и `nested`.
 */

export interface Word {
  text: string;
  /** В слове подстановка (`$x`, `$(…)`, `` `…` ``, `{a,b}`): что в нём будет — неизвестно. */
  dynamic: boolean;
  /** `$` в слове есть и буквальный (`'$x'`, `"\$x"`): по тексту подстановку от него не отличить. */
  literalDollar?: boolean;
  /** Слова, на которые оболочка раскроет `{a,b}` без кавычек: `rm -rf {dist,build}` — два пути. */
  alternatives?: Word[];
  /** Подстановка процесса `<(…)`: текст команды, чей вывод станет этим файлом. */
  fed?: string;
  /** Слово — одна переменная без кавычек (`$T`, не `"$T"`): значение с пробелами станет несколькими словами. */
  splits?: boolean;
  /**
   * Слово целиком в кавычках (`"$N"`, `"$D/x"`): значение подстановки с пробелами
   * остаётся одним словом (R-C06: `N="/c/Program Files/nvm/node.exe"; "$N" x.mjs`).
   */
  unsplit?: boolean;
}

/** Больше вариантов `{…}` слово не раскрывает: дальше — неизвестное слово. */
const MAX_ALTERNATIVES = 32;

/**
 * Одна группа `{a,b,c}` в слове без кавычек и подстановок. Тильда в начале
 * варианта — домашний каталог: оболочка раскрывает её после скобок
 * (`{dist,~/x}` — это `dist` и `~/x`). Вложенные скобки и `{1..3}` — нет.
 */
function braceAlternatives(text: string): Word[] | undefined {
  const match = /^([^{}]*)\{([^{}]*,[^{}]*)\}([^{}]*)$/.exec(text);
  if (!match) return undefined;
  const [, before, inner, after] = match as unknown as [string, string, string, string];
  const parts = inner.split(',');
  if (parts.length > MAX_ALTERNATIVES) return undefined;
  return parts.map((part) => {
    const word = `${before}${part}${after}`;
    return { text: word, dynamic: word.startsWith('~') || word.includes('%') };
  });
}

export interface Redirect {
  /** Поток: `2>` — '2', `&>` — '&', `>` — ''. */
  fd: string;
  /** `>`, `>>`, `>|`, `<`, `<>`, `>&`, `<&`. */
  op: string;
  /** Файл или номер потока (`>&1`). */
  target: Word;
}

export interface Segment {
  words: Word[];
  redirects: Redirect[];
  /** Тела heredoc и here-string — то, что звено получит на вход. */
  inputs: string[];
  /** Вход звена может быть выводом звена раньше: `a | b`, подстановка внутри `b`. */
  piped: boolean;
  /**
   * Номер цепочки `&&`: звенья с одним номером исполняются, только если каждое
   * раньше в цепочке удалось. `;`, перевод строки, `||`, `|`, `&`, `!` и
   * подоболочка начинают новую (`shell-parse.ts`).
   */
  chain?: number;
}

/** Вход в подоболочку или подстановку и выход из неё: каталог внутри — свой. */
export const ENTER = Symbol('enter');
export const LEAVE = Symbol('leave');
/**
 * Дальше состояние оболочки не проследить: тело функции исполнится там и с
 * теми переменными, что будут при вызове, а вызов меняет и состояние снаружи
 * (F-15: `function f { rm -rf ~; }; f` судился как «прочее»).
 */
export const BLIND = Symbol('blind');
export type Step = Segment | typeof ENTER | typeof LEAVE | typeof BLIND;

const BREAK = ' \t\n;&|()<>';
const REDIRECTS = ['<<<', '<<-', '<<', '<>', '<&', '>>', '>|', '>&', '&>>', '&>', '<', '>'];

export class Unparsed extends Error {}

export function fail(): never {
  throw new Unparsed();
}

export interface Pending {
  segment: Segment;
  delimiter: string;
  quoted: boolean;
  strip: boolean;
}

/** Слово при разборе: `plain` — без кавычек и `\`, только такое бывает номером потока и служебным словом. */
export interface Token extends Word {
  plain: boolean;
}

export const wordOf = (token: Token): Word => ({
  text: token.text,
  dynamic: token.dynamic,
  ...(token.literalDollar ? { literalDollar: true } : {}),
  ...(token.alternatives ? { alternatives: token.alternatives } : {}),
  ...(token.splits ? { splits: true } : {}),
  ...(token.unsplit ? { unsplit: true } : {}),
});

export abstract class WordReader {
  pos = 0;
  readonly steps: Step[] = [];
  protected readonly src: string;
  protected readonly pending: Pending[] = [];
  protected depth = 0;

  constructor(src: string) {
    this.src = src;
  }

  /** Список команд до своей `)` (`closing`) или до конца; `inherited` — вход снаружи из трубы. */
  abstract list(closing: boolean, inherited: boolean): void;

  /** Шаги подстановки `` `…` `` — отдельным разбором той же глубины. */
  protected abstract nested(inner: string, piped: boolean): Step[];

  protected word(piped: boolean): Token {
    const src = this.src;
    const token: Token = { text: '', dynamic: false, plain: true };
    const start = this.pos;
    // Незакавыченная часть: фигурные скобки раскрываются только в ней.
    let bare = '';
    // Сколько кусков слова в кавычках: все куски такие — слово не разбивается.
    let quotes = 0;
    while (this.pos < src.length) {
      const ch = src[this.pos] as string;
      if (BREAK.includes(ch)) break;
      if (ch === "'") {
        const end = src.indexOf("'", this.pos + 1);
        if (end < 0) fail();
        const inner = src.slice(this.pos + 1, end);
        if (inner.includes('$')) token.literalDollar = true;
        token.text += inner;
        token.plain = false;
        bare += '\0';
        quotes += 1;
        this.pos = end + 1;
      } else if (ch === '"') {
        this.quoted(token, piped);
        bare += '\0';
        quotes += 1;
      } else if (ch === '\\') {
        // `\;`, `\'` — буква, а не разделитель и не кавычка; `C:\x` без кавычек — уже не тот путь.
        if (src[this.pos + 1] !== '\n') token.text += src.slice(this.pos, this.pos + 2);
        token.dynamic = true;
        token.plain = false;
        bare += '\0';
        this.pos += 2;
      } else if (ch === '`') {
        this.backtick(token, piped, false);
        bare += '\0';
      } else if (ch === '$') {
        this.dollar(token, piped, false);
        bare += '\0';
      } else {
        // `~` раскрывается только в начале слова и после `=`/`:` (`PATH=~/bin`);
        // `RUSYAN~1` — короткое имя Windows, буква. `%TEMP%` — подстановка `cmd`.
        if (ch === '%' || (ch === '~' && (token.text === '' || /[=:]$/.test(token.text)))) {
          token.dynamic = true;
        }
        token.text += ch;
        bare += ch;
        this.pos += 1;
      }
    }
    // `{a,b}` и `{1..3}` — несколько слов; `@{u}`, `stash@{0}` — буквально.
    if (/\{[^{}\0]*(,|\.\.)[^{}\0]*\}/.test(bare)) {
      // Только слово без подстановок: `{$a,b}` раскроется в неизвестное.
      const simple = token.plain && !token.dynamic && !token.literalDollar;
      const alternatives = simple ? braceAlternatives(token.text) : undefined;
      if (alternatives) token.alternatives = alternatives;
      token.dynamic = true;
    }
    if (/^\$(?:[A-Za-z_]\w*|\{[A-Za-z_]\w*\})$/.test(src.slice(start, this.pos)))
      token.splits = true;
    if (quotes > 0 && quotes === bare.length) token.unsplit = true;
    return token;
  }

  private quoted(token: Token, piped: boolean): void {
    const src = this.src;
    token.plain = false;
    this.pos += 1;
    for (;;) {
      if (this.pos >= src.length) fail();
      const ch = src[this.pos] as string;
      const next = src[this.pos + 1];
      if (ch === '"') {
        this.pos += 1;
        return;
      }
      // В двойных кавычках `\` экранирует только `$`, `` ` ``, `"`, `\`; прочее —
      // буквально: `"C:\Users\…"` — путь Windows, а не `C:Users…`.
      if (ch === '\\' && next !== undefined && '$`"\\\n'.includes(next)) {
        if (next === '$') token.literalDollar = true;
        if (next !== '\n') token.text += next;
        this.pos += 2;
      } else if (ch === '`') {
        this.backtick(token, piped, true);
      } else if (ch === '$') {
        this.dollar(token, piped, true);
      } else {
        token.text += ch;
        this.pos += 1;
      }
    }
  }

  private dollar(token: Token, piped: boolean, inQuotes: boolean): void {
    const src = this.src;
    const start = this.pos;
    const next = src[this.pos + 1];
    // За `$` нет имени — это буква, а не подстановка: `sed -i "s/a$/b/"`, `"$/"`,
    // `a$`. Раньше слово считалось неизвестным, и сценарий `sed` шёл человеку.
    if (next === undefined || (!/[\w@*#?$!{(-]/.test(next) && (inQuotes || !`'"`.includes(next)))) {
      token.literalDollar = true;
      token.text += '$';
      this.pos += 1;
      return;
    }
    token.dynamic = true;
    const arithmetic = next === '(' && src[this.pos + 2] === '(' ? this.arithmetic() : -1;
    if (arithmetic >= 0) {
      this.pos = arithmetic;
    } else if (next === '(') {
      this.pos += 2;
      this.steps.push(ENTER);
      this.list(true, piped);
      this.steps.push(LEAVE);
    } else if (next === '{') {
      this.pos = this.parameter();
    } else if (next === "'" && !inQuotes) {
      // `$'…'`: внутри `\'` — кавычка, а не конец строки.
      let j = this.pos + 2;
      for (; j < src.length && src[j] !== "'"; j += 1) if (src[j] === '\\') j += 1;
      if (j >= src.length) fail();
      token.plain = false;
      this.pos = j + 1;
    } else {
      this.pos += 1;
    }
    token.text += src.slice(start, this.pos);
  }

  /**
   * `$((…))`: подстановка или кавычки внутри — не разбираем. Возвращает позицию
   * за `))`; `-1` — это не арифметика: внутренняя скобка закрылась не `))`, и
   * bash исполнит `$( (…) … )` как подстановку команды (F-06:
   * `echo $((rm -rf ~); (true))` разбиралось счётом и проходило само).
   */
  private arithmetic(): number {
    let depth = 0;
    for (let j = this.pos + 1; j < this.src.length; j += 1) {
      const ch = this.src[j];
      if (ch === '(') depth += 1;
      if (ch !== ')') continue;
      depth -= 1;
      if (depth === 1 && this.src[j + 1] !== ')') return -1;
      if (depth === 0) {
        if (/\$\(|[`'"]/.test(this.src.slice(this.pos + 3, j))) fail();
        return j + 1;
      }
    }
    return fail();
  }

  /** `${…}`: подстановка внутри исполнила бы команду, кавычки сбивают поиск `}`. */
  private parameter(): number {
    let depth = 0;
    for (let j = this.pos + 1; j < this.src.length; j += 1) {
      const ch = this.src[j] as string;
      if (ch === '\\') {
        j += 1;
        continue;
      }
      if (`'"\``.includes(ch) || (ch === '$' && this.src[j + 1] === '(')) fail();
      if (ch === '{') depth += 1;
      if (ch === '}' && --depth === 0) return j + 1;
    }
    return fail();
  }

  private backtick(token: Token, piped: boolean, inQuotes: boolean): void {
    const src = this.src;
    let inner = '';
    let j = this.pos + 1;
    for (; j < src.length && src[j] !== '`'; j += 1) {
      const escaped = src[j + 1];
      // В обратных кавычках `\` снимается перед `$`, `` ` ``, `\` (и `"` в двойных).
      if (
        src[j] === '\\' &&
        escaped !== undefined &&
        ('$`\\'.includes(escaped) || (inQuotes && escaped === '"'))
      ) {
        inner += escaped;
        j += 1;
        continue;
      }
      inner += src[j];
    }
    if (j >= src.length) fail();
    this.steps.push(ENTER, ...this.nested(inner, piped), LEAVE);
    token.text += src.slice(this.pos, j + 1);
    token.dynamic = true;
    this.pos = j + 1;
  }

  protected redirect(segment: Segment, fd: string): void {
    const src = this.src;
    const op = REDIRECTS.find((candidate) => src.startsWith(candidate, this.pos)) ?? fail();
    this.pos += op.length;
    if (op === '<<' || op === '<<-') {
      const { text, quoted } = this.delimiter();
      this.pending.push({ segment, delimiter: text, quoted, strip: op === '<<-' });
      return;
    }
    while (src[this.pos] === ' ' || src[this.pos] === '\t') this.pos += 1;
    // `<(…)`, `>(…)` — подстановка процесса: её вход и выход не проследить.
    if (this.pos >= src.length || BREAK.includes(src[this.pos] as string)) fail();
    const target = this.word(segment.piped);
    if (op === '<<<') {
      segment.inputs.push(target.text);
      return;
    }
    segment.redirects.push({
      fd: op.startsWith('&') ? '&' : fd,
      op: op.replace(/^&/, ''),
      target: wordOf(target),
    });
  }

  /** Ограничитель heredoc: в кавычках или с `\` — тело без подстановок. */
  private delimiter(): { text: string; quoted: boolean } {
    const src = this.src;
    while (src[this.pos] === ' ' || src[this.pos] === '\t') this.pos += 1;
    let text = '';
    let quoted = false;
    while (this.pos < src.length) {
      const ch = src[this.pos] as string;
      if (BREAK.includes(ch)) break;
      if (ch === "'" || ch === '"') {
        const end = src.indexOf(ch, this.pos + 1);
        if (end < 0) fail();
        const inner = src.slice(this.pos + 1, end);
        if (ch === '"' && /[`$\\]/.test(inner)) fail();
        text += inner;
        quoted = true;
        this.pos = end + 1;
      } else if (ch === '\\') {
        text += src[this.pos + 1] ?? '';
        quoted = true;
        this.pos += 2;
      } else {
        if (ch === '`' || ch === '$') fail();
        text += ch;
        this.pos += 1;
      }
    }
    if (!text) fail();
    return { text, quoted };
  }

  /** Тела heredoc начинаются со следующей строки — по одному на ожидающий ограничитель. */
  protected bodies(): void {
    const src = this.src;
    for (const doc of this.pending.splice(0)) {
      const lines: string[] = [];
      for (;;) {
        if (this.pos >= src.length) fail();
        const end = src.indexOf('\n', this.pos);
        const raw = src.slice(this.pos, end < 0 ? src.length : end);
        this.pos = end < 0 ? src.length : end + 1;
        const line = doc.strip ? raw.replace(/^\t+/, '') : raw;
        if (line === doc.delimiter) break;
        lines.push(line);
      }
      const body = lines.join('\n');
      // Ограничитель без кавычек — подстановки в теле исполняются.
      if (!doc.quoted && /\$\(|`/.test(body)) fail();
      doc.segment.inputs.push(body);
    }
  }
}
