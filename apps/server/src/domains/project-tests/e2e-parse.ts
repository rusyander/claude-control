/**
 * Разбор файла e2e-теста без его запуска: какие тесты в нём объявлены, в каких
 * `describe` они лежат, какие у них метки и шаги.
 *
 * Разбор текстом, а не исполнением: чужой код панель не запускает, а TypeScript
 * тянуть ради списка имён — несоразмерно. Цена — тест с именем из переменных
 * (шаблон с `${…}`, цикл) не угадывается; такой возвращается в `skipped` с
 * причиной, а не выдумывается.
 *
 * Шаги берутся из того, что пишет сам тест: `test.step('…')` — и комментарии
 * Given/When/Then (`// Дано`/`Когда`/`Тогда` тоже). Это и есть договорённость с
 * агентом: сценарий в коде читается кейсом в панели без второй записи.
 */

export interface ParsedTest {
  /** Имя теста как в коде. */
  title: string;
  /** Имена охватывающих `describe`, снаружи внутрь. */
  titlePath: string[];
  line: number;
  /** Метка `[auth-001]` в имени — id кейса. */
  id?: string;
  /** Метки `@smoke`, `@regression` — из имени и из `{ tag: … }`, без `@`. */
  tags: string[];
  /** Имя без метки id и меток — то, что человек видит заголовком кейса. */
  caseTitle: string;
  precondition?: string;
  steps: string[];
  expected?: string;
  /**
   * Имя теста так, как его пишет отчёт junit каркаса: у Playwright — путь через
   * «›», у Cypress — через пробел, у pytest — модуль, класс и функция через точку.
   */
  testName: string;
}

export interface ParsedSpec {
  tests: ParsedTest[];
  /** Единственный `describe` верхнего уровня — заголовок группы. */
  topDescribe?: string;
  skipped: { line: number; reason: string }[];
}

interface Literal {
  start: number;
  end: number;
  value: string;
  dynamic: boolean;
}

const BEFORE_REGEX = new Set([...'(,=:[!&|?{};+-*%<>~^']);
const KEYWORDS_BEFORE_REGEX = new Set([
  'return',
  'typeof',
  'case',
  'in',
  'of',
  'delete',
  'void',
  'throw',
  'new',
  'else',
  'do',
  'await',
  'yield',
]);

/**
 * `/` на месте `at` начинает регулярку, а не деление: перед ним (без пробелов и
 * комментариев) оператор, открывающая скобка, начало файла или ключевое слово.
 */
function startsRegex(text: string, isCode: Uint8Array, at: number): boolean {
  let k = at - 1;
  while (k >= 0 && (/\s/.test(text[k] ?? '') || !isCode[k])) k -= 1;
  if (k < 0) return true;
  const prev = text[k] ?? '';
  if (BEFORE_REGEX.has(prev)) return true;
  if (!/[\w$]/.test(prev)) return false;
  let start = k;
  while (start > 0 && /[\w$]/.test(text[start - 1] ?? '')) start -= 1;
  return KEYWORDS_BEFORE_REGEX.has(text.slice(start, k + 1));
}

/** Строки и комментарии файла; всё остальное — код. */
function tokenize(text: string): {
  isCode: Uint8Array;
  literals: Map<number, Literal>;
  comments: { start: number; text: string }[];
} {
  const isCode = new Uint8Array(text.length).fill(1);
  const literals = new Map<number, Literal>();
  const comments: { start: number; text: string }[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '/' && next === '/') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      comments.push({ start: i, text: text.slice(i + 2, stop) });
      isCode.fill(0, i, stop);
      i = stop;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      comments.push({ start: i, text: text.slice(i + 2, stop - 2) });
      isCode.fill(0, i, stop);
      i = stop;
      continue;
    }
    if (ch === '/' && startsRegex(text, isCode, i)) {
      // Литерал регулярки: кавычка или обратная кавычка в нём — не начало строки,
      // иначе строка тянулась до следующей такой же и прятала тесты за ней.
      let j = i + 1;
      let inClass = false;
      while (j < text.length && text[j] !== '\n') {
        if (text[j] === '\\') j += 1;
        else if (text[j] === '[') inClass = true;
        else if (text[j] === ']') inClass = false;
        else if (text[j] === '/' && !inClass) break;
        j += 1;
      }
      const stop = Math.min(j + 1, text.length);
      isCode.fill(0, i + 1, stop - 1);
      i = stop;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      let value = '';
      let dynamic = false;
      while (j < text.length && text[j] !== ch) {
        if (text[j] === '\\') {
          value += text[j + 1] ?? '';
          j += 2;
          continue;
        }
        if (ch === '`' && text[j] === '$' && text[j + 1] === '{') dynamic = true;
        if (ch !== '`' && text[j] === '\n') break;
        value += text[j];
        j += 1;
      }
      const stop = Math.min(j + 1, text.length);
      literals.set(i, { start: i, end: stop, value, dynamic });
      isCode.fill(0, i + 1, stop - 1);
      i = stop;
      continue;
    }
    i += 1;
  }
  return { isCode, literals, comments };
}

/** Пары скобок вызовов: индекс `(` → индекс парной `)`, только по коду. */
function parenPairs(text: string, isCode: Uint8Array): Map<number, number> {
  const pairs = new Map<number, number>();
  const stack: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (!isCode[i]) continue;
    if (text[i] === '(') stack.push(i);
    else if (text[i] === ')') {
      const open = stack.pop();
      if (open !== undefined) pairs.set(open, i);
    }
  }
  return pairs;
}

// `specify` и `context` — синонимы `it` и `describe` у Cypress (mocha).
const TEST_CALL =
  /(?<![.\w$])(test|it|specify)(?:\.(?:only|skip|fixme|fail|slow))?\s*\(\s*(?=['"`])/g;
const DESCRIBE_CALL =
  /(?<![.\w$])(?:test\.)?(?:describe|context)(?:\.(?:only|skip|serial|parallel|fixme))*\s*\(\s*(?=['"`])/g;
/** Спека Cypress: команды `cy.*` в коде. От неё зависит только вид имени в отчёте. */
const CYPRESS = /(?<![\w$])cy\.\w+\s*\(/;
const STEP_CALL = /(?<![\w$])test\.step\s*\(\s*(?=['"`])/g;
const ID_MARKER = /\[([\p{L}\p{N}_-]{1,40})\]/u;
const TAG = /(?<![\w@])@([\p{L}\p{N}][\p{L}\p{N}_-]*)/gu;

interface Call {
  at: number;
  open: number;
  close: number;
  title: Literal;
}

function calls(
  text: string,
  pattern: RegExp,
  tokens: ReturnType<typeof tokenize>,
  pairs: Map<number, number>,
): Call[] {
  const found: Call[] = [];
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (!tokens.isCode[at]) continue;
    const open = text.indexOf('(', at);
    const title = tokens.literals.get(at + match[0].length);
    if (!title) continue;
    found.push({ at, open, close: pairs.get(open) ?? text.length, title });
  }
  return found;
}

const lineOf = (text: string, at: number): number => text.slice(0, at).split('\n').length;

/**
 * Метки из текста между именем и телом: `{ tag: '@smoke' }` / `{ tag: ['@a', '@b'] }`
 * у Playwright, `{ tags: … }` у `@cypress/grep`.
 */
function optionTags(text: string, from: number, to: number): string[] {
  const head = text.slice(from, Math.min(to, from + 300));
  const option = head.match(/tags?\s*:\s*(\[[^\]]*\]|['"`][^'"`]*['"`])/);
  return option ? [...(option[1] ?? '').matchAll(TAG)].map((item) => item[1] ?? '') : [];
}

// `\b` в JS — граница ТОЛЬКО латинского слова, даже с флагом `u`: «Дано:» им не
// ловится. Поэтому конец слова — явный «дальше не буква и не цифра».
const WORD_END = '(?![\\p{L}\\p{N}])[:\\s-]*';
const GIVEN = new RegExp(`^\\s*(given|дано|предусловие)${WORD_END}`, 'iu');
const WHEN = new RegExp(`^\\s*(when|когда|шаг)${WORD_END}`, 'iu');
const THEN = new RegExp(`^\\s*(then|тогда|ожидание)${WORD_END}`, 'iu');
const AND = new RegExp(`^\\s*(and|but|но|и)${WORD_END}`, 'iu');

/** Сценарий из комментариев Given/When/Then внутри тела теста. */
function scenario(comments: { start: number; text: string }[], from: number, to: number) {
  const given: string[] = [];
  const steps: string[] = [];
  const then: string[] = [];
  let bucket: string[] | undefined;
  for (const comment of comments) {
    if (comment.start < from || comment.start > to) continue;
    for (const raw of comment.text.split('\n')) {
      const line = raw.replace(/^\s*\*+/, '').trim();
      if (!line) continue;
      const pick = (pattern: RegExp, target: string[]): boolean => {
        if (!pattern.test(line)) return false;
        target.push(line.replace(pattern, '').trim());
        bucket = target;
        return true;
      };
      if (pick(GIVEN, given) || pick(WHEN, steps) || pick(THEN, then)) continue;
      if (bucket && AND.test(line)) bucket.push(line.replace(AND, '').trim());
    }
  }
  return { given, steps, then };
}

/** Разобрать один файл теста. */
export function parseSpec(text: string): ParsedSpec {
  const tokens = tokenize(text);
  const pairs = parenPairs(text, tokens.isCode);
  const describes = calls(text, DESCRIBE_CALL, tokens, pairs);
  const stepCalls = calls(text, STEP_CALL, tokens, pairs);
  const joiner = CYPRESS.test(text) ? ' ' : ' › ';
  const tests: ParsedTest[] = [];
  const skipped: ParsedSpec['skipped'] = [];

  for (const call of calls(text, TEST_CALL, tokens, pairs)) {
    const line = lineOf(text, call.at);
    if (call.title.dynamic) {
      skipped.push({ line, reason: 'dynamic-title' });
      continue;
    }
    const outer = describes.filter((item) => item.open < call.at && item.close > call.at);
    if (outer.some((item) => item.title.dynamic)) {
      skipped.push({ line, reason: 'dynamic-describe' });
      continue;
    }
    const title = call.title.value.trim();
    if (!title) continue;
    const id = title.match(ID_MARKER)?.[1];
    const tags = [
      ...new Set([
        ...[...title.matchAll(TAG)].map((item) => item[1] ?? ''),
        ...optionTags(text, call.title.end, call.close),
      ]),
    ].filter(Boolean);
    const caseTitle =
      title.replace(ID_MARKER, '').replace(TAG, '').replace(/\s+/g, ' ').trim() || title;
    const flow = scenario(tokens.comments, call.open, call.close);
    const named = stepCalls
      .filter((item) => item.at > call.open && item.at < call.close && !item.title.dynamic)
      .map((item) => item.title.value.trim())
      .filter(Boolean);
    const steps = named.length > 0 ? named : flow.steps;
    const titlePath = outer.sort((a, b) => a.at - b.at).map((item) => item.title.value.trim());
    tests.push({
      title,
      titlePath,
      testName: [...titlePath, title].join(joiner),
      line,
      ...(id ? { id } : {}),
      tags,
      caseTitle,
      ...(flow.given.length > 0 ? { precondition: flow.given.join('; ') } : {}),
      steps,
      ...(flow.then.length > 0 ? { expected: flow.then.join('; ') } : {}),
    });
  }

  const top = describes.filter(
    (item) => !describes.some((other) => other.open < item.at && other.close > item.at),
  );
  return {
    tests,
    ...(top.length === 1 && !top[0]?.title.dynamic
      ? { topDescribe: top[0]?.title.value.trim() }
      : {}),
    skipped,
  };
}
