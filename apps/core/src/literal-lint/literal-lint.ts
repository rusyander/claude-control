import ts from 'typescript';

/**
 * Литеральный линт ядра: один механизм, наборы правил — данными (`rule-sets.ts`). Первый набор —
 * P51 (развилка по ОС только в `platform/`), следующий — P108 (имена CLI, провайдеров, маршрутов
 * и моделей только в своих переходниках); оба ходят через этот же разбор, а не через свой
 * линтер каждый. Модуль чистый: файлы ему отдают готовым текстом — чтение диска в ядре
 * принадлежит платформе (`core-io-only-in-platform`), обход дерева делает тест.
 *
 * Два вида текста, по которым ищут правила:
 * - `code` — исходник без комментариев и без содержимого строк (кавычки остаются, длина и
 *   переводы строк сохраняются — номер строки находки честный). Указатель модуля в
 *   `import … from '…'` / `export … from '…'` / `import('…')` / `require('…')` НЕ гасится:
 *   запрет «откуда берётся» пишется по нему. Ключ доступа по индексу (`x['k']`) тоже виден:
 *   это имя члена, а не текст, и `process['…']` — та же развилка, что `process.…` (F-81).
 * - `strings` — значение каждой строки и куска шаблона после разбора экранирования (`'\r\n'`
 *   в исходнике — это CR LF здесь). Указатели модулей сюда не входят; ключи по индексу входят.
 * Комментарии не проверяются никогда: в них правило называют словами.
 *
 * Имя, под которым файл привязал модуль целиком (`import * as o from 'node:os'`, `import o
 * from …`, `const o = require('os')`, `const o = await import('node:os')`), регулярка сама не
 * знает. Поэтому разбор собирает такие имена, а правило пишет `<<os>>` там, где нужен список
 * псевдонимов модуля: механизм подставляет `|o|…` (или пусто) отдельно для каждого файла.
 */

export type LiteralTarget = 'code' | 'strings';

export interface LiteralRule {
  /** Стабильный номер правила внутри набора — его называет находка. */
  id: string;
  in: LiteralTarget;
  /**
   * Источник регулярного выражения (данные, не объект RegExp). `<<модуль>>` (имя без `node:`)
   * заменяется на `|псевдоним|…` — имена, под которыми файл привязал этот модуль целиком.
   */
  pattern: string;
  /** Флаги без `g` — его ставит механизм. */
  flags?: string;
  message: string;
}

export interface LiteralRuleSet {
  /** Номер свойства спецификации (P51, P108 …). */
  id: string;
  /** Где свойство описано — для текста находки. */
  spec: string;
  rules: readonly LiteralRule[];
  /** Папки (от корня проверки, через `/`), где правила набора не действуют. */
  allowed: readonly string[];
  /** Источники регулярных выражений по пути файла: тесты, подставные процессы и т. п. */
  exempt: readonly string[];
}

export interface LiteralSource {
  /** Путь от корня проверки через `/`. */
  path: string;
  text: string;
}

export interface LiteralHit {
  set: string;
  rule: string;
  path: string;
  /** С единицы. */
  line: number;
  column: number;
  match: string;
  message: string;
}

export interface LiteralScan {
  hits: LiteralHit[];
  /** Пути, по которым набор действительно прошёл (не в `allowed`, не в `exempt`). */
  checked: string[];
}

interface Views {
  code: string;
  strings: { start: number; value: string }[];
  /** Модуль (без `node:`) → локальные имена, к которым он привязан целиком. */
  bindings: Map<string, string[]>;
}

const STRINGISH = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
]);

function isModuleSpecifier(node: ts.Node): boolean {
  const parent = node.parent as ts.Node | undefined;
  if (!parent) return false;
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent))
    return parent.moduleSpecifier === node;
  if (ts.isExternalModuleReference(parent)) return true;
  if (ts.isLiteralTypeNode(parent) && ts.isImportTypeNode(parent.parent)) return true;
  return ts.isCallExpression(parent) && isLoadCall(parent) && parent.arguments[0] === node;
}

/** `import('…')` или `require('…')`. */
function isLoadCall(call: ts.CallExpression): boolean {
  return (
    call.expression.kind === ts.SyntaxKind.ImportKeyword ||
    (ts.isIdentifier(call.expression) && call.expression.text === 'require')
  );
}

/** Ключ доступа по индексу: `x['k']`, `x?.['k']`. */
function isElementKey(node: ts.Node): boolean {
  const parent = node.parent as ts.Node | undefined;
  return !!parent && ts.isElementAccessExpression(parent) && parent.argumentExpression === node;
}

/** Модуль без `node:`, если выражение — его загрузка (`await`, скобки, `as`, `!` снимаются). */
function loadedModule(expression: ts.Expression): string | undefined {
  let e: ts.Expression = expression;
  while (
    ts.isAwaitExpression(e) ||
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isNonNullExpression(e)
  )
    e = e.expression;
  if (!ts.isCallExpression(e) || !isLoadCall(e)) return undefined;
  const spec = e.arguments[0];
  return spec && ts.isStringLiteralLike(spec) ? bareModule(spec.text) : undefined;
}

function bareModule(specifier: string): string {
  return specifier.replace(/^node:/, '');
}

/** Имена, к которым узел привязывает модуль целиком (импорт по умолчанию, `* as`, загрузка). */
function wholeModuleBinding(node: ts.Node): [string, string] | undefined {
  if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
    const module = bareModule(node.moduleSpecifier.text);
    const clause = node.importClause;
    if (clause?.name) return [module, clause.name.text];
    const named = clause?.namedBindings;
    if (named && ts.isNamespaceImport(named)) return [module, named.name.text];
    return undefined;
  }
  if (
    ts.isImportEqualsDeclaration(node) &&
    ts.isExternalModuleReference(node.moduleReference) &&
    ts.isStringLiteral(node.moduleReference.expression)
  )
    return [bareModule(node.moduleReference.expression.text), node.name.text];
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
    const module = loadedModule(node.initializer);
    if (module) return [module, node.name.text];
  }
  return undefined;
}

/** Ширина открывающей и закрывающей части у строкового узла (кавычки, `${`, `}`). */
function quoteWidths(kind: ts.SyntaxKind): [number, number] {
  if (kind === ts.SyntaxKind.TemplateHead) return [1, 2];
  if (kind === ts.SyntaxKind.TemplateMiddle) return [1, 2];
  return [1, 1];
}

function blank(chars: string[], from: number, to: number): void {
  for (let i = from; i < to; i += 1) if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' ';
}

export function sourceViews(path: string, text: string): Views {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  // По кодовым единицам UTF-16, как считает позиции TS: `[...text]` склеил бы суррогатную
  // пару в одну ячейку, и гашение сдвинулось бы после первой эмодзи.
  const chars = text.split('');
  const strings: Views['strings'] = [];
  const bindings: Views['bindings'] = new Map();
  const comments = (pos: number): void => {
    const cut = (from: number, to: number): void => blank(chars, from, to);
    ts.forEachLeadingCommentRange(text, pos, cut);
    ts.forEachTrailingCommentRange(text, pos, cut);
  };
  const visit = (node: ts.Node): void => {
    comments(node.getFullStart());
    comments(node.getEnd());
    if (STRINGISH.has(node.kind)) {
      const start = node.getStart(file);
      const end = node.getEnd();
      if (!isModuleSpecifier(node)) {
        if (!isElementKey(node)) {
          const [open, close] = quoteWidths(node.kind);
          blank(chars, start + open, end - close);
        }
        strings.push({ start, value: (node as ts.LiteralLikeNode).text });
      }
      return;
    }
    const bound = wholeModuleBinding(node);
    if (bound) bindings.set(bound[0], [...(bindings.get(bound[0]) ?? []), bound[1]]);
    for (const child of node.getChildren(file)) visit(child);
  };
  visit(file);
  return { code: chars.join(''), strings, bindings };
}

/** `<<модуль>>` → `|имя|…` для этого файла; имена — идентификаторы, экранировать нечего, кроме `$`. */
function expandBindings(pattern: string, bindings: Views['bindings']): string {
  return pattern.replace(/<<([\w.-]+)>>/g, (_, module: string) =>
    (bindings.get(module) ?? []).map((name) => `|${name.replace(/\$/g, '\\$')}`).join(''),
  );
}

function under(path: string, folder: string): boolean {
  const base = folder.replace(/\/+$/, '');
  return path === base || path.startsWith(`${base}/`);
}

export function scanSources(sources: readonly LiteralSource[], set: LiteralRuleSet): LiteralScan {
  const exempt = set.exempt.map((source) => new RegExp(source));
  const compile = (rule: LiteralRule, bindings: Views['bindings']): RegExp =>
    new RegExp(expandBindings(rule.pattern, bindings), `${(rule.flags ?? '').replace('g', '')}g`);
  // Без `<<…>>` выражение одно на все файлы; с ним — своё на каждый файл.
  const fixed = new Map(
    set.rules.filter((rule) => !rule.pattern.includes('<<')).map((r) => [r, compile(r, new Map())]),
  );
  const hits: LiteralHit[] = [];
  const checked: string[] = [];
  for (const source of sources) {
    if (set.allowed.some((folder) => under(source.path, folder))) continue;
    if (exempt.some((regex) => regex.test(source.path))) continue;
    checked.push(source.path);
    const views = sourceViews(source.path, source.text);
    const lines = lineStarts(source.text);
    const at = (pos: number): { line: number; column: number } => {
      let low = 0;
      let high = lines.length - 1;
      while (low < high) {
        const mid = (low + high + 1) >> 1;
        if ((lines[mid] ?? 0) <= pos) low = mid;
        else high = mid - 1;
      }
      return { line: low + 1, column: pos - (lines[low] ?? 0) + 1 };
    };
    for (const rule of set.rules) {
      const regex = fixed.get(rule) ?? compile(rule, views.bindings);
      const report = (pos: number, match: string): void => {
        hits.push({
          set: set.id,
          rule: rule.id,
          path: source.path,
          ...at(pos),
          match,
          message: `${set.id} (${set.spec}): ${rule.message}`,
        });
      };
      if (rule.in === 'code') {
        for (const found of views.code.matchAll(regex)) report(found.index, found[0]);
        continue;
      }
      for (const literal of views.strings) {
        for (const found of literal.value.matchAll(regex)) report(literal.start, found[0]);
      }
    }
  }
  return { hits, checked };
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

export function formatHits(hits: readonly LiteralHit[]): string {
  return hits
    .map(
      (hit) => `${hit.path}:${hit.line}:${hit.column} [${hit.rule}] ${hit.match} — ${hit.message}`,
    )
    .join('\n');
}
