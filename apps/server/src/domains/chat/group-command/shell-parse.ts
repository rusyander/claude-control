/**
 * Звенья команды оболочки с кавычками, подстановками и heredoc — как их видит
 * оболочка. Разбор нужен `group-command.ts`: регулярки по тексту путали слова
 * сообщения коммита с командой и не узнавали составную `cd … && git push … | tail`.
 *
 * Подстановка `$(…)` и `` `…` ``, подоболочка `( … )` разбираются как команды:
 * их звенья идут в список раньше звена, в чьём слове они стоят, между `ENTER`
 * и `LEAVE` — `cd` внутри не меняет каталог снаружи. Тело heredoc и here-string —
 * вход звена (`inputs`): данные для `cat`, сценарий для `bash`. Раньше любая
 * такая форма уводила команду в «не разобрано», и сверка `$(git merge-base …)`
 * или `cat > .agent/tmp/x <<'EOF'` шла карточкой человеку (23.10).
 */

import {
  ENTER,
  LEAVE,
  BLIND,
  Unparsed,
  WordReader,
  fail,
  wordOf,
  type Segment,
  type Step,
} from './shell-words.ts';

export { BLIND, ENTER, LEAVE } from './shell-words.ts';
export type { Redirect, Segment, Step, Word } from './shell-words.ts';

/** Команда не разобрана надёжно: `case`, подстановка процесса, незакрытая кавычка. */
export const UNPARSED = Symbol('unparsed');

/** Служебные слова в начале звена: само звено — то, что после них. */
const KEYWORDS = new Set([
  '{',
  '}',
  '!',
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'do',
  'done',
  'while',
  'until',
  'time',
]);
/** Глубже — не разбираем: рекурсия разбора не должна уронить маршрут прав. */
const MAX_DEPTH = 32;

/**
 * Номера цепочек сквозные на весь процесс: обработчик `trap` разбирается
 * отдельно, и его звено не должно совпасть номером с цепочкой самой команды.
 */
let chains = 0;
const nextChain = (): number => (chains += 1);

const blank = (piped: boolean): Segment => ({ words: [], redirects: [], inputs: [], piped });

class Parser extends WordReader {
  /** Открытые `{`: группа команд или тело функции. */
  private readonly braces: ('fn' | 'group')[] = [];
  /** Номер текущей цепочки `&&` (`Segment.chain`): новый на каждом ином разрыве. */
  private chain = nextChain();

  /** Список команд до своей `)` (`closing`) или до конца; `inherited` — вход снаружи из трубы. */
  list(closing: boolean, inherited: boolean): void {
    const src = this.src;
    this.depth += 1;
    if (this.depth > MAX_DEPTH) fail();
    let segment = blank(inherited);
    // Начало текущего задания: с него `&` уводит звенья в фон.
    let job = this.steps.length;
    // Начало звена трубы и была ли труба в этом задании: каждое звено
    // `a | b` — своя подоболочка (bash без `lastpipe`), и `cd x | cat` каталог
    // снаружи не меняет (F-04: `cd ~; cd <копия> | cat; rm -rf .ssh`).
    let element = this.steps.length;
    let pipeline = false;
    // `! a && b`: `b` идёт, когда `a` НЕ удалось — цепочка рвётся и на отрицании.
    let negated = false;
    const cut = (piped: boolean, chained = false): void => {
      if (segment.words.length > 0 || segment.redirects.length > 0) {
        segment.chain = this.chain;
        this.steps.push(segment);
      }
      if (!chained || negated) this.chain = nextChain();
      negated = false;
      segment = blank(piped || inherited);
    };
    const wrapElement = (): void => {
      this.steps.splice(element, 0, ENTER);
      this.steps.push(LEAVE);
      element = this.steps.length;
    };
    const endPipeline = (): void => {
      if (pipeline) wrapElement();
      pipeline = false;
      element = this.steps.length;
    };
    while (this.pos < src.length) {
      const ch = src[this.pos] as string;
      const next = src[this.pos + 1];
      if (ch === ' ' || ch === '\t') {
        this.pos += 1;
      } else if (ch === '\\' && next === '\n') {
        this.pos += 2;
      } else if (ch === '#') {
        // Комментарий до конца строки: `… | tail -5 # sieve-ack: …`.
        while (this.pos < src.length && src[this.pos] !== '\n') this.pos += 1;
      } else if (ch === '\n') {
        cut(false);
        endPipeline();
        this.pos += 1;
        this.bodies();
        job = this.steps.length;
      } else if (ch === ';') {
        // `;;` и `;&` — ветки `case`.
        if (next === ';' || next === '&') fail();
        cut(false);
        endPipeline();
        this.pos += 1;
        job = this.steps.length;
      } else if (ch === '|' && next === '|') {
        cut(false);
        endPipeline();
        this.pos += 2;
      } else if (ch === '|') {
        cut(true);
        wrapElement();
        pipeline = true;
        this.pos += next === '&' ? 2 : 1;
      } else if (ch === '&' && next === '&') {
        cut(false, true);
        endPipeline();
        this.pos += 2;
      } else if (ch === '&' && next === '>') {
        this.redirect(segment, '&');
      } else if (ch === '&') {
        // Фон — подоболочка: `cd` и присваивания задания наружу не выходят, звенья
        // судятся те же. Раньше любой `&` уводил команду в «не разобрано», и
        // `npm run dev & P=$!; …; kill $P` — погашение своего — шёл человеку (N3, 23.10).
        cut(false);
        endPipeline();
        this.pos += 1;
        if (this.steps.length === job) fail();
        this.steps.splice(job, 0, ENTER);
        this.steps.push(LEAVE);
        job = this.steps.length;
        element = job;
      } else if (ch === ')') {
        if (!closing) fail();
        cut(false);
        endPipeline();
        this.pos += 1;
        this.depth -= 1;
        return;
      } else if (ch === '(') {
        if (this.functionHead(segment)) {
          segment = blank(inherited);
          job = this.steps.length;
          element = job;
          continue;
        }
        // `echo (…)`, `((…))` — не подоболочка.
        if (segment.words.length > 0 || segment.redirects.length > 0 || next === '(') fail();
        // `a && (b)`: подоболочка идёт, только если `a` удалось, — цепочка та же;
        // её `)` рвёт цепочку, и звено после подоболочки начинает новую.
        this.pos += 1;
        this.steps.push(ENTER);
        this.list(true, segment.piped);
        this.steps.push(LEAVE);
      } else if ((ch === '<' || ch === '>') && next === '(') {
        // `<(…)`, `>(…)`: команда внутри исполнится, а слово — путь к её выводу.
        // Раньше разбор падал, и `source <(echo 'rm -rf ~')` уходил правилам чата.
        const start = this.pos;
        this.pos += 2;
        this.steps.push(ENTER);
        this.list(true, false);
        this.steps.push(LEAVE);
        const fed = src.slice(start + 2, this.pos - 1);
        segment.words.push({ text: src.slice(start, this.pos), dynamic: true, fed });
      } else if (ch === '<' || ch === '>') {
        this.redirect(segment, '');
      } else {
        const token = this.word(segment.piped);
        const at = src[this.pos];
        if (token.plain && /^\d+$/.test(token.text) && (at === '<' || at === '>')) {
          this.redirect(segment, token.text);
          continue;
        }
        if (segment.words.length === 0 && token.plain) {
          if (token.text === 'case') fail();
          if (token.text === 'function' || token.text === '{' || token.text === '}') {
            if (token.text === 'function') this.functionKeyword();
            // Шаги функции — свои: задание и звено трубы начинаются после них.
            if (token.text === 'function' || this.brace(token.text)) {
              job = this.steps.length;
              element = job;
            }
            continue;
          }
          if (token.text === '!') negated = true;
          if (KEYWORDS.has(token.text)) continue;
        }
        segment.words.push(wordOf(token));
      }
    }
    if (closing) fail();
    cut(false);
    endPipeline();
    this.depth -= 1;
  }

  finish(): void {
    if (this.pending.length > 0 || this.braces.includes('fn')) fail();
  }

  /** `{` и `}` в начале звена: закрытие тела функции возвращает обход наружу — вслепую. */
  private brace(keyword: string): boolean {
    if (keyword === '{') this.braces.push('group');
    if (keyword !== '}' || this.braces.pop() !== 'fn') return false;
    this.steps.push(LEAVE, BLIND);
    return true;
  }

  /** `имя() {` — звено из одного слова-имени перед `()`. */
  private functionHead(segment: Segment): boolean {
    const [name] = segment.words;
    if (segment.words.length !== 1 || segment.redirects.length > 0 || !name) return false;
    if (name.dynamic || !/^[\w.:@+-]+$/.test(name.text)) return false;
    const head = /^\(\s*\)/.exec(this.src.slice(this.pos));
    if (!head) return false;
    this.pos += head[0].length;
    this.openFunction();
    return true;
  }

  /** `function имя [()] {`. */
  private functionKeyword(): void {
    while (this.src[this.pos] === ' ' || this.src[this.pos] === '\t') this.pos += 1;
    const name = this.word(false);
    if (!name.plain || !name.text) fail();
    const head = /^[ \t]*\(\s*\)/.exec(this.src.slice(this.pos));
    if (head) this.pos += head[0].length;
    this.openFunction();
  }

  /**
   * Тело функции: свою область обход судит вслепую — переменные и каталог
   * будут те, что при вызове. Тело в `( … )` и без скобок не разбираем.
   */
  private openFunction(): void {
    while (/[ \t\n]/.test(this.src[this.pos] ?? '')) this.pos += 1;
    if (this.src[this.pos] !== '{' || !/[ \t\n]/.test(this.src[this.pos + 1] ?? '')) fail();
    this.pos += 1;
    this.braces.push('fn');
    this.steps.push(ENTER, BLIND);
  }

  protected nested(inner: string, piped: boolean): Step[] {
    const nested = new Parser(inner);
    nested.depth = this.depth;
    nested.list(false, piped);
    nested.finish();
    return nested.steps;
  }
}

export function parse(command: string): Step[] | typeof UNPARSED {
  const parser = new Parser(command);
  try {
    parser.list(false, false);
    parser.finish();
  } catch (error) {
    if (error instanceof Unparsed) return UNPARSED;
    throw error;
  }
  return parser.steps;
}
