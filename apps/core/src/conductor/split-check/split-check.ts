import { matchesGlob, toSlashes } from '../../lib/glob/glob.ts';
import type {
  SplitCheckDecision,
  SplitCheckInput,
  SplitEdge,
  SplitProblem,
  SplitQueued,
  SplitSuggestion,
  SplitUnit,
} from './split-check.types.ts';

/**
 * Проверка деления (02 §Split, P39) — единственный судья предложения единиц. Одна единица —
 * принято (по умолчанию работа одна). Две и больше требуют: уникальные имена, известные
 * зависимости без циклов (контракт — неявное ребро к единицам других репозиториев, G19), свои пути
 * без пересечения у единиц, не упорядоченных друг относительно друга (общий файл — слить или
 * поставить одну после другой), ревью одного MR не делится. Отказ называет ВСЕ проблемы разом: план
 * переделывает предложение за один круг, а не по одной находке.
 *
 * Не отказы, а названные пометки: что не влезло в слоты или окно — в очереди; единица больше трёх
 * медиан — подсказка переделить. Решение за человеком или политикой запуска, не за проверкой.
 */

const IMBALANCE_FACTOR = 3;
/** Медиана из двух чисел не даёт ни одной единицы > 3× — сравнение имеет смысл с трёх оценок. */
const IMBALANCE_MIN_KNOWN = 3;

export function decideSplit(input: SplitCheckInput): SplitCheckDecision {
  const { units } = input;
  if (units.length === 0) {
    const problems: SplitProblem[] = [
      { code: 'no-units', units: [], detail: 'proposal names no unit' },
    ];
    return { verdict: 'refused', problems, reasons: problems.map(line) };
  }
  if (units.length === 1) {
    const only = units[0] as SplitUnit;
    return {
      verdict: 'accepted',
      solo: true,
      order: [only.name],
      edges: [],
      queued: [],
      suggestions: [],
      reasons: ['one unit: solo, no split'],
    };
  }

  const problems: SplitProblem[] = [];
  problems.push(...repoProblems(input));
  problems.push(...reviewProblems(input));
  problems.push(...nameProblems(units));
  const { edges, problems: depProblems } = edgesOf(units);
  problems.push(...depProblems);
  const order = topoOrder(units, edges);
  if (order === null) problems.push(cycleProblem(units, edges));
  else problems.push(...sharedProblems(input, edges));

  if (problems.length > 0) return { verdict: 'refused', problems, reasons: problems.map(line) };

  const ordered = order as string[];
  const queued = queuedOf(input, ordered, edges);
  const suggestions = imbalanceOf(units);
  const reasons = [
    `${units.length} units accepted, order ${ordered.join(' → ')}`,
    ...edges.filter((e) => e.why === 'contract').map((e) => `contract ${e.from} precedes ${e.to}`),
    ...queued.map((q) => `${q.unit} queued: ${q.why}`),
    ...unknownEstimates(units),
    ...suggestions.map((s) => s.detail),
  ];
  return { verdict: 'accepted', solo: false, order: ordered, edges, queued, suggestions, reasons };
}

function line(p: SplitProblem): string {
  return `${p.code}: ${p.detail}`;
}

/** Единица в репозитории, которого у задачи нет: её ветку не от чего растить. */
function repoProblems(input: SplitCheckInput): SplitProblem[] {
  const known = input.repoKeys;
  if (!known) return [];
  return input.units
    .filter((u) => !known.includes(u.repoKey))
    .map((u) => ({
      code: 'unknown-repo' as const,
      units: [u.name],
      detail: `${u.name} names repo ${u.repoKey}, not a repo of this task (${known.join(', ')})`,
    }));
}

/** Ревью делится только по MR, которые посчитал разбор (02:69-70): один MR — одно ревью. */
function reviewProblems(input: SplitCheckInput): SplitProblem[] {
  const d = input.deliverable;
  if (d.kind !== 'review') return [];
  const names = input.units.map((u) => u.name);
  if (d.mrCount === null)
    return [
      {
        code: 'review-count-unknown',
        units: names,
        detail: 'review split needs the MR count from intake; none was reported',
      },
    ];
  if (d.mrCount < 2) return [{ code: 'one-review', units: names, detail: 'one review, no split' }];
  return [];
}

function nameProblems(units: readonly SplitUnit[]): SplitProblem[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const u of units) (seen.has(u.name) ? dup : seen).add(u.name);
  return [...dup].map((name) => ({
    code: 'duplicate-name' as const,
    units: [name],
    detail: `unit name ${name} used twice: deps cannot tell them apart`,
  }));
}

function edgesOf(units: readonly SplitUnit[]): { edges: SplitEdge[]; problems: SplitProblem[] } {
  const names = new Set(units.map((u) => u.name));
  const edges: SplitEdge[] = [];
  const problems: SplitProblem[] = [];
  for (const u of units) {
    for (const dep of u.deps) {
      if (dep === u.name)
        problems.push({ code: 'self-dep', units: [u.name], detail: `${u.name} depends on itself` });
      else if (!names.has(dep))
        problems.push({
          code: 'unknown-dep',
          units: [u.name],
          detail: `${u.name} depends on unknown unit ${dep}`,
        });
      else edges.push({ from: dep, to: u.name, why: 'dep' });
    }
  }
  // Контракт раньше потребителей (02:83, G19): каждая единица другого репозитория ждёт его.
  for (const c of units) {
    if (!c.contract) continue;
    for (const u of units) {
      if (u.repoKey === c.repoKey || u.name === c.name) continue;
      const known = edges.some((e) => e.from === c.name && e.to === u.name);
      if (!known) edges.push({ from: c.name, to: u.name, why: 'contract' });
    }
  }
  return { edges, problems };
}

/** Kahn с устойчивым порядком предложения; цикл — `null`. */
function topoOrder(units: readonly SplitUnit[], edges: readonly SplitEdge[]): string[] | null {
  const indeg = new Map(units.map((u) => [u.name, 0]));
  for (const e of edges) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  const out: string[] = [];
  const done = new Set<string>();
  while (out.length < indeg.size) {
    const next = units.find((u) => !done.has(u.name) && indeg.get(u.name) === 0);
    if (!next) return null;
    out.push(next.name);
    done.add(next.name);
    for (const e of edges) if (e.from === next.name) indeg.set(e.to, (indeg.get(e.to) ?? 0) - 1);
  }
  return out;
}

function cycleProblem(units: readonly SplitUnit[], edges: readonly SplitEdge[]): SplitProblem {
  const succ = (n: string) => edges.filter((e) => e.from === n).map((e) => e.to);
  const state = new Map<string, 'open' | 'done'>();
  const stack: string[] = [];
  let cycle: string[] = [];
  const visit = (n: string): boolean => {
    state.set(n, 'open');
    stack.push(n);
    for (const m of succ(n)) {
      if (state.get(m) === 'open') {
        cycle = [...stack.slice(stack.indexOf(m)), m];
        return true;
      }
      if (!state.has(m) && visit(m)) return true;
    }
    stack.pop();
    state.set(n, 'done');
    return false;
  };
  for (const u of units) if (!state.has(u.name) && visit(u.name)) break;
  return {
    code: 'cycle',
    units: [...new Set(cycle)],
    detail: `dependency cycle ${cycle.join(' → ')}`,
  };
}

/** Есть ли путь a→b или b→a: упорядоченные единицы могут делить файл (вторая растёт от ветки первой). */
function ordered(edges: readonly SplitEdge[], a: string, b: string): boolean {
  const reach = (from: string, to: string): boolean => {
    const seen = new Set<string>([from]);
    const queue = [from];
    while (queue.length > 0) {
      const n = queue.shift() as string;
      for (const e of edges) {
        if (e.from !== n || seen.has(e.to)) continue;
        if (e.to === to) return true;
        seen.add(e.to);
        queue.push(e.to);
      }
    }
    return false;
  };
  return reach(a, b) || reach(b, a);
}

function sharedProblems(input: SplitCheckInput, edges: readonly SplitEdge[]): SplitProblem[] {
  const out: SplitProblem[] = [];
  const { units } = input;
  for (let i = 0; i < units.length; i += 1) {
    for (let j = i + 1; j < units.length; j += 1) {
      const a = units[i] as SplitUnit;
      const b = units[j] as SplitUnit;
      if (a.repoKey !== b.repoKey || ordered(edges, a.name, b.name)) continue;
      const files = input.knownFiles?.[a.repoKey];
      const witness = sharedWitness(a.ownedPaths, b.ownedPaths, files, input.foldCase);
      if (witness === null) continue;
      out.push({
        code: 'shared-path',
        units: [a.name, b.name],
        detail: `${a.name} and ${b.name} both own ${witness}: merge them or order one after the other`,
      });
    }
  }
  return out;
}

const GLOB_CHARS = ['*', '?', '['];
const isLiteral = (p: string): boolean => !GLOB_CHARS.some((c) => p.includes(c));

function norm(p: string, foldCase: boolean): string {
  let s = toSlashes(p);
  while (s.startsWith('/')) s = s.slice(1);
  while (s.endsWith('/')) s = s.slice(0, -1);
  return foldCase ? s.toLowerCase() : s;
}

/** Каталог до первого символа маски: всё, что маска может задеть, лежит под ним. */
function literalDir(p: string): string {
  const cut = Math.min(...GLOB_CHARS.map((c) => (p.includes(c) ? p.indexOf(c) : p.length)));
  if (cut === p.length) return p;
  const head = p.slice(0, cut);
  return head.includes('/') ? head.slice(0, head.lastIndexOf('/')) : '';
}

/** Один путь под другим по сегментам (`src` покрывает `src/a`, но не `srcx`); пустой — корень. */
function under(inner: string, outer: string): boolean {
  return outer === '' || inner === outer || inner.startsWith(`${outer}/`);
}

function overlap(
  a: string,
  b: string,
  files: readonly string[] | undefined,
  foldCase: boolean,
): string | null {
  const x = norm(a, foldCase);
  const y = norm(b, foldCase);
  if (isLiteral(x) && isLiteral(y)) {
    if (under(x, y)) return a;
    if (under(y, x)) return b;
    return null;
  }
  if (isLiteral(x) || isLiteral(y)) {
    const [lit, glob, litRaw, globRaw] = isLiteral(x) ? [x, y, a, b] : [y, x, b, a];
    // Свой путь-каталог покрывает всё под собой: маска внутри него — пересечение.
    if (matchesGlob(lit, glob, foldCase, 'rooted')) return litRaw;
    if (under(literalDir(glob), lit)) return globRaw;
    return null;
  }
  const dx = literalDir(x);
  const dy = literalDir(y);
  if (!under(dx, dy) && !under(dy, dx)) return null;
  // Две маски в общем каталоге: по известным файлам — точно; без списка — с запасом.
  if (files === undefined) return `${a} ∩ ${b}`;
  const hit = files.find(
    (f) => matchesGlob(f, a, foldCase, 'rooted') && matchesGlob(f, b, foldCase, 'rooted'),
  );
  return hit ?? null;
}

function sharedWitness(
  a: readonly string[],
  b: readonly string[],
  files: readonly string[] | undefined,
  foldCase: boolean,
): string | null {
  for (const p of a) {
    for (const q of b) {
      const hit = overlap(p, q, files, foldCase);
      if (hit !== null) return hit;
    }
  }
  return null;
}

/**
 * Очередь — названная пометка, не отказ (02:68): корни сверх слотов ждут слота; сверх окна —
 * единицы, чья накопленная оценка в порядке запуска выходит за минуты окна.
 */
function queuedOf(
  input: SplitCheckInput,
  order: readonly string[],
  edges: readonly SplitEdge[],
): SplitQueued[] {
  const out: SplitQueued[] = [];
  const roots = order.filter((n) => !edges.some((e) => e.to === n));
  const slots = Math.max(1, Math.floor(input.capacity.slots));
  for (const n of roots.slice(slots)) out.push({ unit: n, why: 'slots' });
  const window = input.capacity.minutes;
  if (window !== null) {
    let total = 0;
    for (const n of order) {
      const u = input.units.find((x) => x.name === n) as SplitUnit;
      total += u.estimate.minutes ?? 0;
      if (total > window && !out.some((q) => q.unit === n)) out.push({ unit: n, why: 'window' });
    }
  }
  return out;
}

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1
    ? (s[mid] as number)
    : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

function imbalanceOf(units: readonly SplitUnit[]): SplitSuggestion[] {
  const known = units.filter((u) => u.estimate.minutes !== null);
  if (known.length < IMBALANCE_MIN_KNOWN) return [];
  const m = median(known.map((u) => u.estimate.minutes as number));
  return known
    .filter((u) => (u.estimate.minutes as number) > IMBALANCE_FACTOR * m)
    .map((u) => ({
      code: 'resplit' as const,
      unit: u.name,
      detail: `${u.name} estimate ${u.estimate.minutes} min > ${IMBALANCE_FACTOR}× median ${m}: resplit suggested`,
    }));
}

function unknownEstimates(units: readonly SplitUnit[]): string[] {
  const names = units.filter((u) => u.estimate.minutes === null).map((u) => u.name);
  return names.length === 0 ? [] : [`estimate unknown for ${names.join(', ')}`];
}
