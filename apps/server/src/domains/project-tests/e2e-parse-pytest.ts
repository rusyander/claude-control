import type { ParsedSpec, ParsedTest } from './e2e-parse.ts';

/**
 * Разбор файла pytest (`tests/e2e/test_*.py`) без запуска — тем же обещанием,
 * что и у спек JavaScript: имена, группы, метки и сценарий берутся из текста.
 *
 * Тест — функция `test_*` модуля или метод класса `Test*`. Имя кейса — первая
 * строка docstring (в ней же метка `[cart-001]` и `@smoke`), без docstring —
 * имя функции словами. Метки — `@pytest.mark.<имя>` у функции, класса и
 * `pytestmark` модуля; служебные (`parametrize`, `skip`, `xfail`…) метками не
 * считаются. Сценарий — строки Given/When/Then docstring и комментарии `#`.
 *
 * Тест, заведённый в цикле (`globals()[f"test_…"]`, `setattr(…, f"test_…")`),
 * без запуска не назвать — он уходит в `skipped`, как шаблонное имя у Playwright.
 */

const SERVICE_MARKS = new Set([
  'parametrize',
  'skip',
  'skipif',
  'xfail',
  'usefixtures',
  'filterwarnings',
  'timeout',
  'asyncio',
  'django_db',
  'flaky',
  'order',
  'case',
]);

const WORD_END = '(?![\\p{L}\\p{N}])[:\\s-]*';
const GIVEN = new RegExp(`^\\s*(given|дано|предусловие)${WORD_END}`, 'iu');
const WHEN = new RegExp(`^\\s*(when|когда|шаг)${WORD_END}`, 'iu');
const THEN = new RegExp(`^\\s*(then|тогда|ожидание)${WORD_END}`, 'iu');
const AND = new RegExp(`^\\s*(and|but|но|и)${WORD_END}`, 'iu');
const ID_MARKER = /\[([\p{L}\p{N}_-]{1,40})\]/u;
const TAG = /(?<![\w@])@([\p{L}\p{N}][\p{L}\p{N}_-]*)/gu;
const DEF = /^(\s*)(?:async\s+)?def\s+(test_\w*)\s*\(/;
const CLASS = /^(\s*)class\s+(Test\w*)\s*[(:]/;
const ANY_BLOCK = /^(\s*)(?:async\s+)?(?:def|class)\s+\w+/;
const DYNAMIC = /(?:globals\(\)\s*\[\s*f['"]test_|setattr\([^,]+,\s*f['"]test_)/;
const CASE_MARK = /@pytest\.mark\.case\(\s*['"]([\p{L}\p{N}_-]{1,40})['"]/u;

const indentOf = (line: string): number => (line.match(/^\s*/)?.[0] ?? '').length;

function marks(text: string): string[] {
  return [...text.matchAll(/pytest\.mark\.(\w+)/g)]
    .map((match) => match[1] ?? '')
    .filter((name) => name && !SERVICE_MARKS.has(name));
}

/** `)` минус `(` в строке кода — без скобок в строковых литералах и после `#`. */
function parenBalance(line: string): number {
  let balance = 0;
  let quote: string | undefined;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quote) {
      if (char === '\\') i += 1;
      else if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '#') break;
    else if (char === ')') balance += 1;
    else if (char === '(') balance -= 1;
  }
  return balance;
}

/** Декораторы прямо над строкой `at` (многострочные тоже) — одним текстом. */
function decoratorsAbove(lines: string[], at: number, indent: number): string {
  const out: string[] = [];
  let depth = 0;
  for (let i = at - 1; i >= 0; i -= 1) {
    const line = lines[i] ?? '';
    if (!line.trim()) break;
    // Комментарий между декораторами — не конец их списка.
    if (depth <= 0 && line.trim().startsWith('#')) continue;
    depth += parenBalance(line);
    const decorator = indentOf(line) === indent && line.trim().startsWith('@');
    if (!decorator && depth <= 0) break;
    out.unshift(line);
    if (decorator && depth <= 0) continue;
  }
  return out.join('\n');
}

/** Первая непустая строка текста, без краевых пробелов. */
function firstLine(text: string | undefined): string | undefined {
  const line = text
    ?.split('\n')
    .find((item) => item.trim())
    ?.trim();
  return line || undefined;
}

/** Docstring сразу под `def`/`class` на строке `at`: текст и где кончился. */
function docstringAfter(lines: string[], at: number): string | undefined {
  // Заголовок функции бывает многострочным — docstring после первой строки с «:» в конце.
  let start = at;
  while (start < lines.length && !/:\s*(#.*)?$/.test(lines[start] ?? '')) start += 1;
  const first = (lines[start + 1] ?? '').trim();
  const quote = first.startsWith('"""') ? '"""' : first.startsWith("'''") ? "'''" : undefined;
  if (!quote) return undefined;
  const body = first.slice(3);
  const close = body.indexOf(quote);
  if (close !== -1) return body.slice(0, close);
  const parts = [body];
  for (let i = start + 2; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const end = line.indexOf(quote);
    if (end !== -1) {
      parts.push(line.slice(0, end));
      break;
    }
    parts.push(line);
  }
  return parts.join('\n');
}

/** Тело блока, начатого на строке `at`: строки глубже его отступа. */
function bodyOf(lines: string[], at: number, indent: number): string[] {
  const out: string[] = [];
  for (let i = at + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line.trim() && indentOf(line) <= indent) break;
    out.push(line);
  }
  return out;
}

function scenario(lines: string[]): { given: string[]; steps: string[]; then: string[] } {
  const given: string[] = [];
  const steps: string[] = [];
  const then: string[] = [];
  let bucket: string[] | undefined;
  for (const raw of lines) {
    // Кавычки docstring на строке шага — не часть шага.
    const line = raw
      .replace(/^\s*#+/, '')
      .replace(/^\s*(?:"""|''')|(?:"""|''')\s*$/g, '')
      .trim();
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
  return { given, steps, then };
}

/** Модуль теста так, как его называет junit pytest: путь от корня через точки. */
export function pytestModule(file: string): string {
  return file.replace(/\\/g, '/').replace(/\.py$/, '').split('/').filter(Boolean).join('.');
}

/** Разобрать файл pytest; `file` — путь от корня проекта, из него имя модуля. */
export function parsePytest(text: string, file: string): ParsedSpec {
  const lines = text.split(/\r?\n/);
  const tests: ParsedTest[] = [];
  const skipped: ParsedSpec['skipped'] = [];
  const module = pytestModule(file);
  const moduleMarks = marks(
    lines
      .filter((line) => /^pytestmark\s*=/.test(line) || /^\s+pytest\.mark\./.test(line))
      .join('\n'),
  );
  // Открытые классы `Test*`: отступ и имя. Закрывается любой строкой не глубже.
  const classes: { indent: number; name: string; marks: string[] }[] = [];
  let nestedDef: number | undefined;
  /** Первая строка docstring первого класса `Test*` — имя группы, если модуль промолчал. */
  let classDoc: string | undefined;

  lines.forEach((line, index) => {
    if (!line.trim() || line.trim().startsWith('#')) return;
    const indent = indentOf(line);
    while (classes.length > 0 && indent <= (classes.at(-1)?.indent ?? -1)) classes.pop();
    if (nestedDef !== undefined && indent <= nestedDef) nestedDef = undefined;

    if (DYNAMIC.test(line)) {
      skipped.push({ line: index + 1, reason: 'dynamic-title' });
      return;
    }
    const klass = line.match(CLASS);
    if (klass) {
      const own = marks(decoratorsAbove(lines, index, indent));
      classes.push({ indent, name: klass[2] ?? '', marks: own });
      classDoc ??= firstLine(docstringAfter(lines, index));
      return;
    }
    const def = line.match(DEF);
    const owner = classes.at(-1);
    const inClass = owner !== undefined && indent > owner.indent;
    // Функция внутри функции pytest не собирает: это помощник, не тест.
    if (def && nestedDef === undefined && (indent === 0 || inClass)) {
      const name = def[2] ?? '';
      const decorators = decoratorsAbove(lines, index, indent);
      const doc = docstringAfter(lines, index);
      const head =
        doc
          ?.split('\n')
          .find((item) => item.trim())
          ?.trim() ?? '';
      const id = decorators.match(CASE_MARK)?.[1] ?? head.match(ID_MARKER)?.[1];
      const titleFromDoc = head.replace(ID_MARKER, '').replace(TAG, '').replace(/\s+/g, ' ').trim();
      const caseTitle =
        titleFromDoc ||
        name
          .replace(/^test_?/, '')
          .replace(/_+/g, ' ')
          .trim() ||
        name;
      const tags = [
        ...new Set([
          ...moduleMarks,
          ...classes.flatMap((item) => item.marks),
          ...marks(decorators),
          ...[...head.matchAll(TAG)].map((match) => match[1] ?? ''),
        ]),
      ].filter(Boolean);
      const body = bodyOf(lines, index, indent);
      // Тело уже несёт строки docstring: взять их ещё раз — задвоить сценарий.
      const flow = scenario(body);
      const titlePath = classes.map((item) => item.name);
      tests.push({
        title: head || name,
        titlePath,
        line: index + 1,
        ...(id ? { id } : {}),
        tags,
        caseTitle,
        ...(flow.given.length > 0 ? { precondition: flow.given.join('; ') } : {}),
        steps: flow.steps,
        ...(flow.then.length > 0 ? { expected: flow.then.join('; ') } : {}),
        testName: [module, ...titlePath, name].join('.'),
      });
      // Всё глубже теста — его тело: вложенная `def test_…` там тестом не станет.
      nestedDef = indent;
      return;
    }
    if (ANY_BLOCK.test(line) && /\bdef\b/.test(line) && nestedDef === undefined) nestedDef = indent;
  });

  const moduleDoc = /^\s*(?:"""|''')/.test(lines.find((line) => line.trim()) ?? '')
    ? docstringAfter(['x:', ...lines.slice(lines.findIndex((line) => line.trim()))], 0)
    : undefined;
  // Имя группы — docstring модуля, без него — первого класса: иначе группа
  // называлась именем файла («profile»), хотя класс нёс человеческое имя.
  const topDescribe = firstLine(moduleDoc) ?? classDoc;
  return { tests, ...(topDescribe ? { topDescribe } : {}), skipped };
}
