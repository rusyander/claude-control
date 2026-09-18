import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { serverMessageCodes } from '@agentdeck/contracts/server-messages';

/**
 * Русская строка сервера без кода — это текст, который английский интерфейс
 * покажет по-русски. Решение владельца (17.09.2026): человеческий текст ответа
 * едет с кодом (`messageCode`/`detailCode`/… или `coded(…)`), клиент переводит
 * код, строка остаётся запасной.
 *
 * Отличить «уходит человеку» от «уходит модели в промпт» по тексту нельзя,
 * поэтому граница — закреплённый список: сколько русских литералов БЕЗ кода
 * осталось в каждом файле и почему (промпт агента, журнал, разбор чужого
 * формата…). Новый литерал без кода краснит тест, и убранный тоже — закрепка
 * обязана сжиматься вместе с кодом, а не врать о прошлом.
 *
 * Литерал считается закодированным, если код стоит рядом: в ближайшем объекте,
 * в одном из двух ближайших вызовов/конструкторов или в самой инструкции.
 * Переписать закрепку — осознанный шаг: `WRITE_RU_PINS=1 pnpm vitest run
 * src/bootstrap/server-ru-literals.test.ts`, затем разобрать дифф.
 */
const SRC = resolve(import.meta.dirname, '..');
const PINS = join(import.meta.dirname, 'server-ru-literals.pins.json');
const CYRILLIC = /[А-Яа-яЁё]/;
const MARKER =
  /\b(?:message|detail|reason|hint|title|label|note|summary|text|error|why|status|warning|problem|content|description)Code\b|\bcoded\(/;
/** Код, переданный обёртке позиционно (`invalidField(…, 'request-…')`), — тоже код. */
const KNOWN_CODES = new Set<string>(serverMessageCodes);
const QUOTED = /'([a-z][a-z0-9]*(?:-[a-z0-9]+)+)'/g;

function hasCode(text: string): boolean {
  if (MARKER.test(text)) return true;
  for (const match of text.matchAll(QUOTED)) if (KNOWN_CODES.has(match[1] ?? '')) return true;
  return false;
}
/** Инструкция длиннее — уже не «рядом»: код соседней ветки не должен засчитываться. */
const STATEMENT_LIMIT = 700;

interface Pin {
  n: number;
  why: string;
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__fixtures__' ? [] : sources(path);
    return entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.d.ts')
      ? [path]
      : [];
  });
}

/** Вызов `super(…)` инструкцией: код класс вешает следующей строкой. */
function isSuperCall(node: ts.Node): boolean {
  return (
    ts.isExpressionStatement(node) &&
    ts.isCallExpression(node.expression) &&
    node.expression.expression.kind === ts.SyntaxKind.SuperKeyword
  );
}

function isCoded(node: ts.Node, file: ts.SourceFile): boolean {
  let calls = 0;
  let objectSeen = false;
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isObjectLiteralExpression(current) && !objectSeen) {
      objectSeen = true;
      if (hasCode(current.getText(file))) return true;
    }
    if ((ts.isCallExpression(current) || ts.isNewExpression(current)) && calls < 2) {
      calls += 1;
      if (hasCode(current.getText(file))) return true;
    }
    if (ts.isStatement(current) || ts.isClassElement(current) || ts.isSourceFile(current)) {
      const text = current.getText(file);
      if (text.length <= STATEMENT_LIMIT && hasCode(text)) return true;
      // Текст внутри `super(…)` кода при себе не несёт: до вызова `super` нет
      // `this`, и класс ошибки вешает код следующей строкой (`coded(this, …)`).
      // Поэтому «рядом» здесь — не инструкция, а тело конструктора.
      if (isSuperCall(current)) continue;
      return false;
    }
  }
  return false;
}

function literalText(node: ts.Node, file: ts.SourceFile): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.getText(file);
  return undefined;
}

function uncodedRussianLiterals(path: string, text = readFileSync(path, 'utf8')): number {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  let count = 0;
  const visit = (node: ts.Node): void => {
    const value = literalText(node, file);
    if (value !== undefined) {
      // Импорт/экспорт по пути и тип-литерал — не текст для человека.
      if (CYRILLIC.test(value) && !ts.isLiteralTypeNode(node.parent) && !isCoded(node, file))
        count += 1;
      if (ts.isTemplateExpression(node))
        node.templateSpans.forEach((span) => visit(span.expression));
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return count;
}

describe('русские литералы сервера без кода', () => {
  it('совпадают с закреплённым списком (новый — краснеет, убранный — тоже)', () => {
    const pins = JSON.parse(readFileSync(PINS, 'utf8')) as Record<string, Pin>;
    const actual: Record<string, number> = {};
    for (const path of sources(SRC)) {
      const n = uncodedRussianLiterals(path);
      if (n > 0) actual[relative(SRC, path).replaceAll('\\', '/')] = n;
    }
    if (process.env.WRITE_RU_PINS === '1') {
      const next: Record<string, Pin> = {};
      for (const [file, n] of Object.entries(actual).sort(([a], [b]) => a.localeCompare(b)))
        next[file] = { n, why: pins[file]?.why ?? 'unclassified' };
      writeFileSync(PINS, `${JSON.stringify(next, null, 2)}\n`);
      return;
    }
    const drift: string[] = [];
    for (const [file, n] of Object.entries(actual)) {
      const pinned = pins[file]?.n ?? 0;
      if (n > pinned) drift.push(`${file}: ${n} > ${pinned} — новый русский текст без кода`);
      if (n < pinned) drift.push(`${file}: ${n} < ${pinned} — закрепка устарела, опустите её`);
    }
    for (const file of Object.keys(pins))
      if (!(file in actual)) drift.push(`${file}: 0 < ${pins[file]?.n} — закрепка устарела`);
    expect(drift).toEqual([]);
    const total = Object.values(actual).reduce((sum, n) => sum + n, 0);
    expect(total).toBeGreaterThan(0);
  });

  it('счётчик видит русский текст без кода и не считает закодированный', () => {
    const probe = [
      "reply.code(400).send({ message: 'Нет такого' });",
      "reply.code(400).send({ message: 'Нет такого', messageCode: 'x' });",
      "throw coded(new GitError('Ветка занята'), 'git-branch-busy');",
      "throw new GitError('Ветка занята');",
      "throw invalidField('q', 'нужен текст', 'request-search-text-required', { field: 'q' });",
      "throw invalidField('q', 'нужен текст', 'not-a-known-code');",
      '// комментарий по-русски не литерал',
      'const t = `Файл ${name} пуст`;',
      // Код у текста в `super(…)` стоит следующей строкой — это закодировано.
      "class A extends Error { constructor() { super('Ветка занята'); coded(this, 'git-branch-busy'); } }",
      "class B extends Error { constructor() { super('Ветка занята'); this.name = 'B'; } }",
    ].join('\n');
    expect(uncodedRussianLiterals('probe.ts', probe)).toBe(5);
  });
});
