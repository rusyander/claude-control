import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Корень `src/` ядра — свой, а не из общей программы: часть не тянет чужие файлы (core-parts-apart).
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Поиск по коду ядра (P33, каталог этапа 8): каждый литерал объекта `kind: 'signal'` (строка
 * журнала) — пары `data.signal` × `data.severity`, сведённые проверяющим TypeScript к строковым
 * литералам (литерал, константа, тернарный выбор, тип-объединение литералов, разворот `...`,
 * параметр локальной функции — по аргументам каждого её вызова в том же файле); и каждый
 * сработавший вердикт/решение (`fired: true` + `signal`) — его id и серьёзность, если она в
 * литерале. Значение, которое к литералам не сводится, — `null`: сайт либо в списке исключений
 * теста с причиной, либо краснит каталог.
 */

export interface SignalPair {
  ids: string[] | null;
  severities: string[] | null;
}

export interface SignalSite {
  /** `путь/от/src.ts:строка`. */
  at: string;
  file: string;
  /** Обычно одна пара; у записи через локальную функцию — пара на каждый её вызов. */
  pairs: SignalPair[];
}

/** Литерал `fired: true` с id сигнала: вердикт предиката или решение судьи класса. */
export interface Producer {
  at: string;
  file: string;
  ids: string[] | null;
  /** `null` — серьёзности в литерале нет (вердикт: её даёт каталог). */
  severities: string[] | null;
}

export interface SignalScan {
  writes: SignalSite[];
  producers: Producer[];
}

function unwrap(expr: ts.Expression): ts.Expression {
  let e = expr;
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isNonNullExpression(e)
  )
    e = e.expression;
  return e;
}

function literalStrings(type: ts.Type): string[] | null {
  const parts = type.isUnion() ? type.types : [type];
  if (parts.length === 0 || !parts.every((p) => p.isStringLiteral())) return null;
  return [...new Set(parts.map((p) => (p as ts.StringLiteralType).value))].sort();
}

function merge(a: string[] | null, b: string[] | null): string[] | null {
  return a && b ? [...new Set([...a, ...b])].sort() : null;
}

function valueSymbol(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  return ts.isShorthandPropertyAssignment(node)
    ? checker.getShorthandAssignmentValueSymbol(node)
    : checker.getSymbolAtLocation(node);
}

function declOf(symbol: ts.Symbol | undefined): ts.Declaration | undefined {
  return symbol?.valueDeclaration ?? symbol?.declarations?.[0];
}

/** Инициализатор переменной `const x = …` за идентификатором; нет — `undefined`. */
function initializerOf(checker: ts.TypeChecker, id: ts.Node): ts.Expression | undefined {
  const decl = declOf(valueSymbol(checker, id));
  return decl && ts.isVariableDeclaration(decl) ? decl.initializer : undefined;
}

function stringsOf(checker: ts.TypeChecker, node: ts.Expression): string[] | null {
  const e = unwrap(node);
  if (ts.isStringLiteralLike(e)) return [e.text];
  if (ts.isConditionalExpression(e))
    return merge(stringsOf(checker, e.whenTrue), stringsOf(checker, e.whenFalse));
  const typed = literalStrings(checker.getTypeAtLocation(e));
  if (typed) return typed;
  const init = ts.isIdentifier(e) ? initializerOf(checker, e) : undefined;
  return init ? stringsOf(checker, init) : null;
}

/** Литерал объекта за выражением `data`: сам литерал или `const data = {…}` выше. */
function objectOf(checker: ts.TypeChecker, node: ts.Node): ts.ObjectLiteralExpression | null {
  if (ts.isShorthandPropertyAssignment(node)) {
    const init = initializerOf(checker, node);
    return init ? objectOf(checker, init) : null;
  }
  if (!ts.isExpression(node)) return null;
  const e = unwrap(node);
  if (ts.isObjectLiteralExpression(e)) return e;
  const init = ts.isIdentifier(e) ? initializerOf(checker, e) : undefined;
  return init ? objectOf(checker, init) : null;
}

const nameOf = (p: ts.ObjectLiteralElementLike): string | undefined =>
  p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : undefined;

/** Значение — параметр функции, привязанной к имени (`const f = (a) => …` / `function f(a)`). */
interface ParamRef {
  binding: ts.Symbol;
  index: number;
}

type Value = { strings: string[] | null } | { param: ParamRef };

function paramRef(checker: ts.TypeChecker, node: ts.Node): ParamRef | undefined {
  const target = ts.isShorthandPropertyAssignment(node)
    ? node
    : ts.isExpression(node)
      ? unwrap(node)
      : node;
  if (!ts.isIdentifier(target) && !ts.isShorthandPropertyAssignment(target)) return undefined;
  const decl = declOf(valueSymbol(checker, target));
  if (!decl || !ts.isParameter(decl)) return undefined;
  const fn = decl.parent;
  const index = fn.parameters.indexOf(decl);
  const holder =
    ts.isFunctionDeclaration(fn) && fn.name
      ? fn.name
      : (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) &&
          ts.isVariableDeclaration(fn.parent) &&
          ts.isIdentifier(fn.parent.name)
        ? fn.parent.name
        : undefined;
  const binding = holder ? checker.getSymbolAtLocation(holder) : undefined;
  return binding ? { binding, index } : undefined;
}

/** Значение свойства литерала объекта: прямое, сокращённое, из разворота `...x`, из типа `data`. */
function propValue(
  checker: ts.TypeChecker,
  obj: ts.ObjectLiteralExpression | null,
  dataExpr: ts.Node,
  name: string,
): Value {
  if (obj) {
    for (const p of obj.properties) {
      if (nameOf(p) !== name) continue;
      if (ts.isPropertyAssignment(p)) {
        const param = paramRef(checker, p.initializer);
        return param ? { param } : { strings: stringsOf(checker, p.initializer) };
      }
      if (ts.isShorthandPropertyAssignment(p)) {
        const param = paramRef(checker, p);
        if (param) return { param };
        const symbol = checker.getShorthandAssignmentValueSymbol(p);
        const typed = symbol ? literalStrings(checker.getTypeOfSymbolAtLocation(symbol, p)) : null;
        if (typed) return { strings: typed };
        const init = initializerOf(checker, p);
        return { strings: init ? stringsOf(checker, init) : null };
      }
    }
    for (const p of obj.properties) {
      if (!ts.isSpreadAssignment(p)) continue;
      const prop = checker.getTypeAtLocation(p.expression).getProperty(name);
      if (prop) return { strings: literalStrings(checker.getTypeOfSymbolAtLocation(prop, p)) };
    }
    return { strings: null };
  }
  const prop = checker.getTypeAtLocation(dataExpr).getProperty(name);
  return {
    strings: prop ? literalStrings(checker.getTypeOfSymbolAtLocation(prop, dataExpr)) : null,
  };
}

/** Вызовы функции `binding` в файле: аргументы по позициям. */
function callsOf(
  checker: ts.TypeChecker,
  sf: ts.SourceFile,
  binding: ts.Symbol,
): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  const visit = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      checker.getSymbolAtLocation(n.expression) === binding
    )
      out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function pairsOf(checker: ts.TypeChecker, sf: ts.SourceFile, id: Value, sev: Value): SignalPair[] {
  const binding = 'param' in id ? id.param.binding : 'param' in sev ? sev.param.binding : undefined;
  if (!binding) {
    return [
      {
        ids: 'strings' in id ? id.strings : null,
        severities: 'strings' in sev ? sev.strings : null,
      },
    ];
  }
  const at = (v: Value, call: ts.CallExpression): string[] | null => {
    if ('strings' in v) return v.strings;
    if (v.param.binding !== binding) return null;
    const arg = call.arguments[v.param.index];
    return arg ? stringsOf(checker, arg) : null;
  };
  const calls = callsOf(checker, sf, binding);
  if (calls.length === 0) return [{ ids: null, severities: null }];
  return calls.map((call) => ({ ids: at(id, call), severities: at(sev, call) }));
}

function isSourceFile(rel: string): boolean {
  return (
    !rel.startsWith('..') &&
    !rel.endsWith('.test.ts') &&
    !rel.includes('__fixtures__') &&
    !rel.endsWith('.d.ts')
  );
}

export function scanSignals(program: ts.Program): SignalScan {
  const checker = program.getTypeChecker();
  const writes: SignalSite[] = [];
  const producers: Producer[] = [];
  for (const sf of program.getSourceFiles()) {
    const file = relative(SRC, sf.fileName).replaceAll('\\', '/');
    if (!isSourceFile(file)) continue;
    const at = (n: ts.Node) =>
      `${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
    const visit = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node)) {
        const prop = (name: string) =>
          node.properties.find(
            (p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && nameOf(p) === name,
          );
        const kind = prop('kind');
        const data = node.properties.find((p) => nameOf(p) === 'data');
        if (kind && stringsOf(checker, kind.initializer)?.join() === 'signal' && data) {
          const expr = ts.isPropertyAssignment(data)
            ? data.initializer
            : ts.isShorthandPropertyAssignment(data)
              ? data
              : undefined;
          if (expr) {
            const obj = objectOf(checker, expr);
            const id = propValue(checker, obj, expr, 'signal');
            const sev = propValue(checker, obj, expr, 'severity');
            writes.push({ at: at(node), file, pairs: pairsOf(checker, sf, id, sev) });
          }
        }
        const fired = prop('fired');
        if (fired && unwrap(fired.initializer).kind === ts.SyntaxKind.TrueKeyword) {
          const id = propValue(checker, node, node, 'signal');
          const sev = propValue(checker, node, node, 'severity');
          producers.push({
            at: at(node),
            file,
            ids: 'strings' in id ? id.strings : null,
            severities: 'strings' in sev ? sev.strings : null,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { writes, producers };
}
