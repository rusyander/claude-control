import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';
import { coreProgram, PROGRAM_TIMEOUT_MS, SRC } from '../__fixtures__/ts-program.ts';
import type { SelftestPair } from './__fixtures__/selftest.ts';
import { scanSignals, type SignalScan } from './__fixtures__/signal-scan.ts';
import { SIGNAL_CATALOG, signalDef } from './catalog.ts';
import { foldObserver, initObserverFold } from './fold.ts';
import type { SignalDef } from './observer.types.ts';
import { OBSERVER_PREDICATES } from './registry.ts';

/**
 * Каталог сигналов этапа 8 (F12, P33, P96) проверяется по коду, а не по памяти:
 * (a) поиск по программе TypeScript ядра находит каждую запись `kind:'signal'` и каждый
 *     сработавший вердикт — их id в каталоге, написанная серьёзность = серьёзность каталога, и
 *     каждый id каталога где-то пишется;
 * (b) пара каждого предиката (срабатывает / почти-двойник) идёт через `foldObserver` со всеми
 *     предикатами реестра;
 * (c) тест, названный самопроверкой строки, существует (по дереву describe/it файла);
 * (d) точка человека только 5–7 или никакой, и наблюдатель не тянет поднимателя точек.
 */

/**
 * Сайты записи, id которых не литерал по устройству. `write.ts` пишет строку решения
 * наблюдателя: id приходит из вердикта, серьёзность — из каталога через судью; сами вердикты
 * найдены поиском как производители (`fired: true`). `judge.ts` — тот самый судья.
 */
const EXEMPT: Readonly<Record<string, string>> = {
  'bootstrap/observer-wiring/write.ts':
    'writes the judged verdict: id from the verdict, severity from the catalog',
  'observer/judge.ts': 'the judge copies the verdict id; producers are scanned instead',
};

/**
 * Сайты, что пишут решение судьи класса (`SignalDecision`): серьёзность у них типом шире, чем
 * пишется, — её дают литералы производителей (`forged-publish.ts`, `hook-block.ts`, …).
 */
const PASSTHROUGH: readonly string[] = [
  'bootstrap/conductor-wiring/guard.ts',
  'bootstrap/user-layer-wiring/tap.ts',
];

/**
 * Сигналы без теста ядра (самопроверка `null`). Сейчас пусто: новый сигнал без теста краснит (c),
 * пока его не назовут здесь осознанно.
 */
const UNTESTED: readonly string[] = [];

/**
 * Предикаты, чья пара в `__fixtures__/selftests.ts` ещё не сдана: каталог держит место, а сдача
 * пары краснит этот список — id уходит отсюда, и пару гоняет тест (b). Сейчас сданы все.
 */
const AWAITING: readonly string[] = [];

const HUMAN_RAISER = resolve(SRC, 'conductor/human/raise.ts');
const OBSERVER_ROOTS = ['observer/', 'bootstrap/observer-wiring/'];

interface Finding {
  at: string;
  problem: string;
}

/** Нарушения поиска против каталога; пусто — каталог полон и честен. */
function auditScan(scan: SignalScan, catalog: (id: string) => SignalDef | undefined): Finding[] {
  const out: Finding[] = [];
  const written = new Map<string, Set<string>>();
  const seen = new Set<string>();
  const note = (id: string, sevs: readonly string[] | null) => {
    seen.add(id);
    if (!sevs) return;
    const set = written.get(id) ?? new Set<string>();
    for (const s of sevs) set.add(s);
    written.set(id, set);
  };
  for (const w of scan.writes) {
    if (EXEMPT[w.file]) continue;
    for (const p of w.pairs) {
      if (!p.ids) {
        out.push({ at: w.at, problem: 'signal id does not resolve to string literals' });
        continue;
      }
      for (const id of p.ids) {
        if (!catalog(id)) out.push({ at: w.at, problem: `id ${id} is not in the catalog` });
        note(id, PASSTHROUGH.includes(w.file) ? null : p.severities);
      }
      if (!p.severities && !PASSTHROUGH.includes(w.file))
        out.push({ at: w.at, problem: 'severity does not resolve to string literals' });
    }
  }
  for (const v of scan.producers) {
    if (EXEMPT[v.file]) continue;
    if (!v.ids) {
      out.push({ at: v.at, problem: 'verdict signal does not resolve to string literals' });
      continue;
    }
    for (const id of v.ids) {
      if (!catalog(id)) out.push({ at: v.at, problem: `verdict id ${id} is not in the catalog` });
      note(id, v.severities);
    }
  }
  for (const [id, sevs] of written) {
    const def = catalog(id);
    if (!def) continue;
    const got = [...sevs].sort().join(',');
    const want = [...def.severities].sort().join(',');
    if (got !== want)
      out.push({ at: id, problem: `written severities [${got}] ≠ catalog [${want}]` });
  }
  return out.concat(
    SIGNAL_CATALOG.filter((d) => !seen.has(d.id)).map((d) => ({
      at: d.id,
      problem: 'catalog id is written nowhere in the core',
    })),
  );
}

/** Модули, до которых файл доходит импортами (по разрешению самого TypeScript). */
function reaches(program: ts.Program, from: string, target: string): boolean {
  const options = program.getCompilerOptions();
  const seen = new Set<string>();
  const stack = [resolve(from)];
  while (stack.length > 0) {
    const file = stack.pop() as string;
    if (file === target) return true;
    if (seen.has(file)) continue;
    seen.add(file);
    const sf = program.getSourceFile(file);
    if (!sf) continue;
    for (const stmt of sf.statements) {
      // Импорт только типов в рантайме не существует — поднять точку через него нельзя.
      const typeOnly = ts.isImportDeclaration(stmt)
        ? stmt.importClause?.isTypeOnly === true
        : ts.isExportDeclaration(stmt) && stmt.isTypeOnly;
      const spec =
        (ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt)) &&
        !typeOnly &&
        stmt.moduleSpecifier &&
        ts.isStringLiteral(stmt.moduleSpecifier)
          ? stmt.moduleSpecifier.text
          : undefined;
      if (!spec) continue;
      const hit = ts.resolveModuleName(spec, file, options, ts.sys).resolvedModule;
      if (hit && !hit.isExternalLibraryImport) stack.push(resolve(hit.resolvedFileName));
    }
  }
  return false;
}

function raiserImporters(program: ts.Program): string[] {
  return program
    .getSourceFiles()
    .map((sf) => resolve(sf.fileName))
    .filter((f) => {
      const rel = f.slice(SRC.length + 1).replaceAll('\\', '/');
      return (
        OBSERVER_ROOTS.some((r) => rel.startsWith(r)) &&
        !rel.endsWith('.test.ts') &&
        !rel.includes('__fixtures__')
      );
    })
    .filter((f) => reaches(program, f, HUMAN_RAISER))
    .map((f) => f.slice(SRC.length + 1).replaceAll('\\', '/'));
}

/** Полные пути vitest «describe > it» файла: по дереву вызовов, не по тексту. */
function testNames(file: string): Set<string> {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const names = new Set<string>();
  const visit = (node: ts.Node, path: string[]): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const base = ts.isPropertyAccessExpression(callee) ? callee.expression : callee;
      const name = ts.isIdentifier(base) ? base.text : '';
      const arg = node.arguments[0];
      if (['describe', 'it', 'test'].includes(name) && arg && ts.isStringLiteralLike(arg)) {
        const next = [...path, arg.text];
        if (name === 'describe') node.arguments.slice(1).forEach((a) => visit(a, next));
        else names.add(next.join(' > '));
        return;
      }
    }
    ts.forEachChild(node, (c) => visit(c, path));
  };
  visit(sf, []);
  return names;
}

async function selftestPairs(): Promise<SelftestPair[]> {
  const root = dirname(fileURLToPath(import.meta.url));
  const pairs: SelftestPair[] = [];
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory() || dir.name.startsWith('__')) continue;
    const file = join(root, dir.name, '__fixtures__', 'selftests.ts');
    if (!existsSync(file)) continue;
    // Сбой импорта не глотается: пары, которые не грузятся, — красный каталог, а не «пар нет».
    const mod = (await import(pathToFileURL(file).href)) as { SELFTESTS?: SelftestPair[] };
    pairs.push(...(mod.SELFTESTS ?? []));
  }
  return pairs;
}

function fires(pair: SelftestPair, side: 'fires' | 'silent'): number {
  const ctx = { windowOf: pair.windowOf ?? (() => null), now: () => 0 };
  let state = initObserverFold();
  let count = 0;
  for (const line of pair[side]) {
    const step = foldObserver(state, line, ctx, OBSERVER_PREDICATES);
    expect(step.errors).toEqual([]);
    state = step.state;
    count += step.verdicts.filter((v) => v.signal === pair.signal).length;
  }
  return count;
}

let program: ts.Program;
let scan: SignalScan;

beforeAll(() => {
  program = coreProgram();
  scan = scanSignals(program);
}, PROGRAM_TIMEOUT_MS);

describe('stage 8 signal catalog', () => {
  it('ids are unique; every registered predicate emits only catalog predicate ids', () => {
    const ids = SIGNAL_CATALOG.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(signalDef('no-such-signal')).toBeUndefined();
    const emittedByPredicates = OBSERVER_PREDICATES.flatMap((p) => p.ids);
    for (const id of emittedByPredicates) expect(signalDef(id)?.kind, id).toBe('predicate');
    // Обратно: строка `predicate` без предиката в реестре — сигнал, который никто не выведет.
    for (const d of SIGNAL_CATALOG.filter((x) => x.kind === 'predicate'))
      expect(emittedByPredicates, d.id).toContain(d.id);
  });

  it('every row is self-consistent: its judged severity is one it writes, stop only stops the step', () => {
    for (const d of SIGNAL_CATALOG) {
      expect(d.severities, d.id).toContain(d.severity);
      if (d.escalated) expect(d.severities, d.id).toContain(d.escalated.severity);
      if (d.kind === 'emitted')
        expect(d.action, d.id).toBe(d.severity === 'stop' ? 'stop-step' : 'show');
      if (d.hint) expect(d.action, d.id).toBe('hint');
      expect(d.fpThreshold, d.id).toBe(0);
    }
  });

  it('(a) code scan: every signal write and fired verdict resolves to catalog ids with the catalog severities, every catalog id is written', () => {
    expect(scan.writes.length).toBeGreaterThan(20);
    expect(auditScan(scan, signalDef)).toEqual([]);
  });

  it(
    '(a, d) negative: a planted unknown id, a wrong severity and an observer import of the human-point raiser are all caught',
    () => {
      const planted = coreProgram({
        'observer/zz-planted.ts': [
          "import { raiseHumanPoint } from '../conductor/human/raise.ts';",
          'export const keep = raiseHumanPoint;',
          "export const row = { kind: 'signal', data: { signal: 'zz-unknown', severity: 'warn' } };",
          "export const bad = { kind: 'signal', data: { signal: 'keep-warm', severity: 'stop' } };",
        ].join('\n'),
      });
      const problems = auditScan(scanSignals(planted), signalDef).map((f) => f.problem);
      expect(problems).toContain('id zz-unknown is not in the catalog');
      expect(problems).toContain('written severities [info,stop] ≠ catalog [info]');
      expect(raiserImporters(planted)).toEqual(['observer/zz-planted.ts']);
    },
    PROGRAM_TIMEOUT_MS,
  );

  it('(b) every predicate has a selftest pair that fires through foldObserver, and its near-miss twin stays silent', async () => {
    const pairs = await selftestPairs();
    const bySignal = new Map(pairs.map((p) => [p.signal, p]));
    for (const d of SIGNAL_CATALOG.filter((x) => x.kind === 'predicate')) {
      const pair = bySignal.get(d.id);
      if (AWAITING.includes(d.id)) {
        // Пара сдана — убрать id из списка ожидания, чтобы её гонял этот тест.
        expect(pair === undefined, `${d.id} delivered: drop it from AWAITING`).toBe(true);
        continue;
      }
      expect(pair, `${d.id} has no SELFTESTS pair`).toBeDefined();
      if (!pair) continue;
      expect(fires(pair, 'fires'), `${d.id} fires`).toBeGreaterThan(0);
      expect(fires(pair, 'silent'), `${d.id} near-miss`).toBe(0);
    }
    for (const p of pairs) expect(signalDef(p.signal)?.kind, p.signal).toBe('predicate');
  });

  it('(c) every named selftest exists as a test; predicates name their near-miss too', () => {
    const cache = new Map<string, Set<string>>();
    for (const d of SIGNAL_CATALOG) {
      if (!d.selftest) {
        // Без самопроверки — только названные сигналы без теста; предикат без неё не бывает.
        expect(d.kind, d.id).toBe('emitted');
        expect(UNTESTED, `${d.id} has no selftest`).toContain(d.id);
        continue;
      }
      expect(UNTESTED, `${d.id} is tested now: drop it from UNTESTED`).not.toContain(d.id);
      const file = resolve(SRC, d.selftest.file);
      const names = cache.get(file) ?? testNames(file);
      cache.set(file, names);
      expect([...names], `${d.id} fires`).toContain(d.selftest.fires);
      if (d.kind === 'predicate') expect(d.selftest.silent, d.id).not.toBeNull();
      if (d.selftest.silent) expect([...names], `${d.id} silent`).toContain(d.selftest.silent);
    }
  });

  it('(d) P96: no row raises a human point outside 5-7; the observer never reaches the human-point raiser', () => {
    for (const d of SIGNAL_CATALOG)
      expect(d.humanPoint === null || [5, 6, 7].includes(d.humanPoint), d.id).toBe(true);
    expect(raiserImporters(program)).toEqual([]);
  });
});
