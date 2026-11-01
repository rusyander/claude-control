import { hasValue, type Fact } from './os-kind.ts';
import {
  osProcessTable,
  type ProcessIdentity,
  type ProcessRow,
  type ProcessTableSource,
} from './process-table.ts';

/**
 * Жив ли процесс, известный по номеру и времени старта (P12, платформенная половина).
 * Ядро при загрузке сверяет свои процессы (хосты сессий, проверки) именно так: номер жив,
 * но время старта другое — номер занял чужой, свой процесс мёртв.
 *
 * Один снимок на «тик»: проверка десятка процессов не запускает PowerShell десять раз —
 * снимок живёт `ttlMs`, параллельные вопросы ждут один и тот же запрос (09: «batched per
 * tick»). Нет снимка — ответ `unknown`, никогда не `dead` (F25): по `unknown` ядро
 * не объявляет сессию потерянной.
 */

export type { ProcessIdentity, ProcessRow, ProcessTableSource } from './process-table.ts';

export type Liveness = 'alive' | 'dead' | 'unknown';

/**
 * `fresh` — ответ только по снимку, начатому после вопроса: «жив» из кэша такта не принимается.
 * Нужен там, где «жив» выдаёт что-то наружу (адрес сервера задаче): процесс, умерший внутри
 * такта, иначе остался бы живым до его конца.
 */
export interface LivenessQuestion {
  fresh?: boolean;
}

export interface LivenessProbe {
  isAlive(id: ProcessIdentity, question?: LivenessQuestion): Promise<Liveness>;
  identityOf(pid: number): Promise<Fact<ProcessIdentity>>;
  /** Снимок этого тика (общий для всех вопросов тика). */
  snapshot(): Promise<Fact<ProcessRow[]>>;
}

export function livenessIn(rows: readonly ProcessRow[], id: ProcessIdentity): Liveness {
  const row = rows.find((item) => item.pid === id.pid);
  if (!row || row.zombie) return 'dead';
  // Время ОС не сказала (системный процесс) — личность не доказать.
  if (!row.start) return 'unknown';
  return row.start === id.start ? 'alive' : 'dead';
}

/**
 * Кэш тика отвечает «жив» и «личность» сразу, но «мёртв» и «нет такого» — только по снимку,
 * начатому ПОСЛЕ вопроса (F-30): процесс, родившийся после снимка тика (соседнее ядро на
 * загрузке), в старом снимке отсутствует, и кэш объявил бы его мёртвым — его строку стёрли бы
 * из procs.json, его замок перехватили. Отрицательный ответ из кэша перепроверяется одним
 * свежим чтением; вопросы одного тика делят его (номер чтения больше отметки вопроса).
 */
export function createLivenessProbe(
  source: ProcessTableSource = osProcessTable(),
  ttlMs = 1_000,
  now: () => number = Date.now,
): LivenessProbe {
  let reads = 0;
  let cached: { at: number; seq: number; fact: Promise<Fact<ProcessRow[]>> } | undefined;
  const refresh = (): { seq: number; fact: Promise<Fact<ProcessRow[]>> } => {
    reads += 1;
    cached = { at: now(), seq: reads, fact: source.read() };
    return cached;
  };
  const current = (): { seq: number; fact: Promise<Fact<ProcessRow[]>> } => {
    const at = now();
    if (!cached || at - cached.at >= ttlMs) return refresh();
    return cached;
  };
  /** Снимок, начатый не раньше отметки `mark` (номера чтения на момент вопроса). */
  const freshSince = (mark: number): Promise<Fact<ProcessRow[]>> =>
    cached && cached.seq > mark ? cached.fact : refresh().fact;
  const snapshot = (): Promise<Fact<ProcessRow[]>> => current().fact;
  return {
    snapshot,
    async isAlive(id, question) {
      const mark = reads;
      if (question?.fresh) {
        const fresh = await freshSince(mark);
        return hasValue(fresh) ? livenessIn(fresh.value, id) : 'unknown';
      }
      const tick = current();
      const fact = await tick.fact;
      const verdict = hasValue(fact) ? livenessIn(fact.value, id) : 'unknown';
      if (verdict !== 'dead' || tick.seq > mark) return verdict;
      const fresh = await freshSince(mark);
      return hasValue(fresh) ? livenessIn(fresh.value, id) : 'unknown';
    },
    async identityOf(pid) {
      const mark = reads;
      const tick = current();
      let fact = await tick.fact;
      if (hasValue(fact) && tick.seq <= mark && !fact.value.some((item) => item.pid === pid))
        fact = await freshSince(mark);
      if (!hasValue(fact)) return fact;
      const row = fact.value.find((item) => item.pid === pid);
      if (!row) return { absent: true };
      if (!row.start) return { unknown: `pid ${pid}: start time not exposed` };
      return { value: { pid: row.pid, start: row.start } };
    },
  };
}

/**
 * Процессор дерева процесса (user + kernel, мс) по ОДНОМУ снимку: сам процесс и все потомки
 * обходом по `ppid`. Корня нет или его процессор ОС не отдала — `null`; потомок без процессора
 * в сумму не входит (у CIM бывает строка без него). Цикл в `ppid` (pid 0 — свой родитель) не
 * зацикливает обход.
 */
export function treeCpuMs(rows: readonly ProcessRow[], rootPid: number): number | null {
  const root = rows.find((r) => r.pid === rootPid);
  if (typeof root?.cpuMs !== 'number') return null;
  const children = new Map<number, ProcessRow[]>();
  for (const r of rows) {
    if (r.pid === r.ppid) continue;
    children.set(r.ppid, [...(children.get(r.ppid) ?? []), r]);
  }
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  let sum = 0;
  while (queue.length > 0) {
    const pid = queue.shift() as number;
    const row = pid === rootPid ? root : rows.find((r) => r.pid === pid);
    if (typeof row?.cpuMs === 'number') sum += row.cpuMs;
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      queue.push(child.pid);
    }
  }
  return Math.round(sum);
}

/** Проба одной личности: жив ли и сколько процессора съело его дерево к моменту снимка. */
export interface TreeProbe {
  verdict: Liveness;
  cpuMs: number | null;
}

/**
 * Проба пачки личностей ОДНИМ снимком тика (03:165, 09: «batched per tick»): живость по pid +
 * старту и процессор дерева каждого. Снимок не прочитан — все `unknown`, процессора нет. «Мёртв»
 * из снимка перепроверяется путём `isAlive` (F-30: снимок мог быть начат до вопроса) — свежий
 * снимок читается только тогда, на редкой смерти, а не на каждой пробе.
 */
export async function probeTrees(
  probe: LivenessProbe,
  ids: readonly ProcessIdentity[],
): Promise<TreeProbe[]> {
  if (ids.length === 0) return [];
  const fact = await probe.snapshot();
  if (!hasValue(fact)) return ids.map(() => ({ verdict: 'unknown', cpuMs: null }));
  const rows = fact.value;
  const out: TreeProbe[] = [];
  for (const id of ids) {
    let verdict = livenessIn(rows, id);
    if (verdict === 'dead') verdict = await probe.isAlive(id);
    out.push({ verdict, cpuMs: verdict === 'alive' ? treeCpuMs(rows, id.pid) : null });
  }
  return out;
}

/** Личность процесса по номеру — одним свежим снимком (без кэша тика). */
export async function identityOfPid(
  pid: number,
  source: ProcessTableSource = osProcessTable(),
): Promise<Fact<ProcessIdentity>> {
  return createLivenessProbe(source, 0).identityOf(pid);
}

/**
 * Таблица процессов для тестов ядра (P12): строки задаются и меняются тестом, `fail`
 * изображает ОС, которая не ответила. Живёт в платформе, а не в тестах: журналу и
 * дирижёру она нужна в их собственных тестах сверки при загрузке.
 */
export interface FakeProcessTable extends ProcessTableSource {
  set(rows: ProcessRow[]): void;
  fail(reason: string | undefined): void;
  reads(): number;
}

export function fakeProcessTable(initial: ProcessRow[] = []): FakeProcessTable {
  let rows = [...initial];
  let failure: string | undefined;
  let count = 0;
  return {
    async read() {
      count += 1;
      return failure ? { unknown: failure } : { value: [...rows] };
    },
    set(next) {
      rows = [...next];
    },
    fail(reason) {
      failure = reason;
    },
    reads: () => count,
  };
}
