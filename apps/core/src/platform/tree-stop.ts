import {
  currentOs,
  factReason,
  hasValue,
  reasonOf,
  sleep,
  type Fact,
  type OsKind,
} from './os-kind.ts';
import { livenessIn } from './process-identity.ts';
import {
  osProcessTable,
  type ProcessIdentity,
  type ProcessRow,
  type ProcessTableSource,
} from './process-table.ts';
import { markerSweep, type MarkerSweep } from './env-marker.ts';
import { runWinHelper } from './win-helper.ts';

/**
 * Остановка дерева процессов (P53, 03 §Launcher). Перенос `lib/kill-tree.mjs` сервера:
 * дерево строится самим ядром по снимку и связь «родитель → ребёнок» признаётся только
 * если ребёнок НЕ старше родителя — Windows не чистит ppid, и сирота с унаследованным
 * номером родителя иначе сошла бы за потомка (2026-09-27 так сняли живой сторож стенда).
 *
 * Кого снимаем: потомков корня по снимку + `known` (потомки из прошлых снимков — сирота,
 * чей родитель уже вышел, в нынешнем дереве не видна) + находки поиска по метке окружения
 * (Linux `/proc/*\/environ`, macOS `ps -E`, Windows — окружение из PEB через помощник).
 * Каждый снимается по личности (номер + старт). Windows — по дескриптору со сверкой времени
 * создания на том же дескрипторе; POSIX — TERM, `graceMs`, KILL и опрос до ухода
 * (`killWaitMs`). В конце — повторный снимок и
 * повторный поиск: кто жив — `residual`. Процесс без метки (сбросил окружение) и вне дерева
 * находит разница портов конца шага (`resource-scan.ts`), иначе он называется остатком.
 */

export interface TreeStopOptions {
  /** POSIX: сколько ждать после TERM до KILL (09: 5 с). */
  graceMs?: number;
  /** POSIX: сколько после KILL ждать ухода процессов из таблицы, прежде чем назвать остаток (2 с). */
  killWaitMs?: number;
  /** Потомки, замеченные прошлыми снимками (журнал снимков на каждом событии инструмента). */
  known?: readonly ProcessIdentity[];
  /** Метка окружения дерева (`AGENTDECK_TREE=<id>`), по которой ищутся переродители. */
  marker?: { name: string; value: string };
  /** POSIX: корень — лидер своей группы (`detached`), группе уходит сигнал целиком. */
  group?: boolean;
  /** Номер, который не снимается ни при каком снимке (по умолчанию — сам процесс). */
  selfPid?: number;
}

export interface TreeStopReport {
  /** Кому ушла остановка (личности на момент снимка). */
  targeted: ProcessIdentity[];
  /** Найдены поиском по метке, а не обходом дерева. */
  sweepFound: ProcessIdentity[];
  /** Живы после остановки и повторной проверки — остаток, который называется. */
  residual: ProcessIdentity[];
  /**
   * Не доказано (F25): снимка не было (`residual` тогда = корень), поиск по метке не ответил
   * (F-64), повторная сверка не прочитана. Чистая остановка — только без этого поля.
   */
  unknown?: string;
}

export interface TreeStopDeps {
  source?: ProcessTableSource;
  os?: OsKind;
  /** POSIX-сигнал (подменяется в тестах); бросает, если процесса нет. */
  signal?: (pid: number, name: NodeJS.Signals) => void;
  /** Windows-снятие по плану `pid start` → исход на номер. */
  terminate?: (targets: readonly ProcessIdentity[]) => Promise<Map<number, string> | undefined>;
  sweep?: MarkerSweep;
  pollMs?: number;
}

/**
 * Потомки корня листьями вперёд (корень последним). Ребёнок старше родителя — сирота с
 * унаследованным номером, не потомок; процесс без времени старта в дерево не входит.
 */
export function descendantsOf(
  rows: readonly ProcessRow[],
  root: ProcessIdentity,
  selfPid = process.pid,
): ProcessRow[] {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const top = byPid.get(root.pid);
  if (!top || top.start !== root.start) return [];
  const children = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    if (row.ppid === row.pid) continue;
    const list = children.get(row.ppid);
    if (list) list.push(row);
    else children.set(row.ppid, [row]);
  }
  const order: ProcessRow[] = [];
  const seen = new Set<number>([top.pid]);
  const visit = (parent: ProcessRow): void => {
    for (const kid of children.get(parent.pid) ?? []) {
      if (seen.has(kid.pid) || !kid.start) continue;
      if (
        Number.isFinite(kid.startMs) &&
        Number.isFinite(parent.startMs) &&
        kid.startMs < parent.startMs
      )
        continue;
      seen.add(kid.pid);
      visit(kid);
    }
    order.push(parent);
  };
  visit(top);
  return order.filter((row) => row.pid !== selfPid);
}

export function parseKillOutcomes(text: string): Map<number, string> | undefined {
  const outcomes = new Map<number, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^(\d+) (killed|gone|denied|reused|failed)$/.exec(line.trim());
    if (match) outcomes.set(Number(match[1]), match[2] ?? '');
  }
  return outcomes.size > 0 ? outcomes : undefined;
}

async function terminateWindows(
  targets: readonly ProcessIdentity[],
): Promise<Map<number, string> | undefined> {
  const plan = targets.map((target) => `${target.pid} ${target.start}`).join(';');
  if (!plan) return new Map();
  const run = await runWinHelper('kill', plan);
  return run.ok ? parseKillOutcomes(run.stdout) : undefined;
}

function posixSignal(pid: number, name: NodeJS.Signals): void {
  process.kill(pid, name);
}

function aliveIn(rows: readonly ProcessRow[], ids: readonly ProcessIdentity[]): ProcessIdentity[] {
  return ids.filter((id) => livenessIn(rows, id) === 'alive');
}

function uniq(ids: readonly ProcessIdentity[]): ProcessIdentity[] {
  const seen = new Set<string>();
  return ids.filter((id) => {
    const key = `${id.pid}:${id.start}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function stopTree(
  root: ProcessIdentity,
  options: TreeStopOptions = {},
  deps: TreeStopDeps = {},
): Promise<TreeStopReport> {
  const os = deps.os ?? currentOs();
  const source = deps.source ?? osProcessTable(os);
  const rawSweep = deps.sweep ?? markerSweep(source, os);
  const doubts: string[] = [];
  const selfPid = options.selfPid ?? process.pid;

  const first = await source.read();
  if (!hasValue(first))
    return { targeted: [], sweepFound: [], residual: [root], unknown: factReason(first) };
  // Метку несёт и строка запуска того, кто её ищет (`grep AGENTDECK_TREE=…` в `ps -E`
  // неотличим от окружения): потомок дерева не старше корня — старший не наш. Тот же порог
  // снимает подозрение с закрытого своего процесса старше корня (ssh-agent на Linux).
  const rootStartMs = first.value.find(
    (row) => row.pid === root.pid && row.start === root.start,
  )?.startMs;
  const scope = rootStartMs === undefined ? {} : { bornAfterMs: rootStartMs };
  // Поиск по метке, который не ответил (чтение окружения/таблицы упало, поиск бросил), — не
  // «никого нет» (F-64): иначе остановка выглядела бы чистой, и слот отдавался при живой сироте.
  const sweep = async (name: string, value: string): Promise<Fact<ProcessIdentity[]>> => {
    try {
      return await rawSweep(name, value, scope);
    } catch (error) {
      return { unknown: reasonOf(error) };
    }
  };
  const tree = descendantsOf(first.value, root, selfPid).map(({ pid, start }) => ({ pid, start }));
  const known = aliveIn(first.value, options.known ?? []);
  const found = options.marker
    ? await sweep(options.marker.name, options.marker.value)
    : { value: [] };
  const young = (ids: readonly ProcessIdentity[], rows: readonly ProcessRow[]): ProcessIdentity[] =>
    ids.filter((id) => {
      if (id.pid === selfPid) return false;
      const row = rows.find((item) => item.pid === id.pid && item.start === id.start);
      return rootStartMs === undefined || !row || !(row.startMs < rootStartMs - 1_000);
    });
  if (!hasValue(found)) doubts.push(`marker sweep: ${factReason(found)}`);
  const sweepFound = hasValue(found) ? young(found.value, first.value) : [];
  // Листья вперёд: сначала дерево (оно уже упорядочено), потом сироты.
  const targets = uniq([...tree, ...known, ...sweepFound]).filter((id) => id.pid !== selfPid);

  await stopIdentities(targets, os, options, deps, source, root);

  // Повторный поиск: потомок, родившийся во время остановки (fork под TERM), — тоже наш.
  const late = options.marker
    ? await sweep(options.marker.name, options.marker.value)
    : { value: [] };
  if (!hasValue(late)) doubts.push(`late marker sweep: ${factReason(late)}`);
  const lateTable = hasValue(late) && late.value.length > 0 ? await source.read() : undefined;
  const isTarget = (id: ProcessIdentity) =>
    targets.some((t) => t.pid === id.pid && t.start === id.start);
  // Поиск нашёл, а таблицу не прочитать: найденных не сверить и не снять — они остаток.
  const unverified =
    hasValue(late) && lateTable && !hasValue(lateTable)
      ? late.value.filter((id) => id.pid !== selfPid && !isTarget(id))
      : [];
  if (lateTable && !hasValue(lateTable)) doubts.push(`late table: ${factReason(lateTable)}`);
  // Таблица прочитана ПОСЛЕ поиска: кого в ней нет — уже вышел, снимать нечего.
  const lateIds =
    hasValue(late) && lateTable && hasValue(lateTable)
      ? young(late.value, lateTable.value).filter((id) =>
          lateTable.value.some((row) => row.pid === id.pid && row.start === id.start),
        )
      : [];
  const fresh = lateIds.filter((id) => !isTarget(id));
  if (fresh.length > 0) await stopIdentities(fresh, os, options, deps, source, root);

  const after = await source.read();
  const all = uniq([...targets, ...fresh]);
  if (!hasValue(after)) doubts.push(`read-back: ${factReason(after)}`);
  const residual = uniq([...(hasValue(after) ? aliveIn(after.value, all) : all), ...unverified]);
  return {
    targeted: all,
    sweepFound: uniq([...sweepFound, ...fresh, ...unverified]),
    residual,
    ...(doubts.length > 0 ? { unknown: doubts.join('; ') } : {}),
  };
}

/** Остановить перечисленные процессы по личности (без дерева) — сироты разницы портов. */
export async function stopProcesses(
  ids: readonly ProcessIdentity[],
  options: Pick<TreeStopOptions, 'graceMs' | 'killWaitMs'> = {},
  deps: TreeStopDeps = {},
): Promise<{ residual: ProcessIdentity[]; unknown?: string }> {
  const os = deps.os ?? currentOs();
  const source = deps.source ?? osProcessTable(os);
  await stopIdentities(ids, os, options, deps, source, undefined);
  const after = await source.read();
  if (!hasValue(after)) return { residual: [...ids], unknown: factReason(after) };
  return { residual: aliveIn(after.value, ids) };
}

async function stopIdentities(
  targets: readonly ProcessIdentity[],
  os: OsKind,
  options: TreeStopOptions,
  deps: TreeStopDeps,
  source: ProcessTableSource,
  root: ProcessIdentity | undefined,
): Promise<void> {
  if (targets.length === 0) return;
  if (os === 'win32') {
    const terminate = deps.terminate ?? terminateWindows;
    const outcomes = await terminate(targets);
    if (outcomes) return;
    // Помощник недоступен: по номеру, но только после сверки личности свежим снимком.
    const table = await source.read();
    if (!hasValue(table)) return;
    for (const id of aliveIn(table.value, targets)) trySignal(deps, id.pid, 'SIGKILL');
    return;
  }
  // Номер мог освободиться до сигнала — сверка личности перед каждой волной. Сигнал уходит только
  // сверенным (`live`), групповой — только если корень сверен тем же снимком: номер группы
  // корня, отданный чужому лидеру, иначе снял бы чужую группу (F-28).
  const send = (
    name: NodeJS.Signals,
    verified: readonly ProcessIdentity[],
    rows: readonly ProcessRow[],
  ): void => {
    if (options.group && root && livenessIn(rows, root) === 'alive')
      trySignal(deps, -root.pid, name);
    for (const id of verified) trySignal(deps, id.pid, name);
  };
  const before = await source.read();
  if (!hasValue(before)) return;
  const live = aliveIn(before.value, targets);
  if (live.length === 0) return;
  send('SIGTERM', live, before.value);
  const deadline = Date.now() + (options.graceMs ?? 5_000);
  const poll = deps.pollMs ?? 100;
  for (;;) {
    const table = await source.read();
    if (!hasValue(table)) return;
    const rest = aliveIn(table.value, live);
    if (rest.length === 0) return;
    if (Date.now() >= deadline) {
      send('SIGKILL', rest, table.value);
      await settleKilled(rest, options, poll, source);
      return;
    }
    await sleep(poll);
  }
}

/**
 * После KILL — опрос таблицы до ухода всех снятых, не дольше `killWaitMs`. Ядро снимает KILL не
 * мгновенно: под нагрузкой (весь набор в контейнере) выход не успевал за один опрос в 100 мс, и
 * повторный снимок называл умирающий процесс остатком. Кто жив к сроку — остаток по-настоящему.
 */
async function settleKilled(
  killed: readonly ProcessIdentity[],
  options: TreeStopOptions,
  poll: number,
  source: ProcessTableSource,
): Promise<void> {
  const deadline = Date.now() + (options.killWaitMs ?? 2_000);
  for (;;) {
    await sleep(poll);
    const table = await source.read();
    if (!hasValue(table) || aliveIn(table.value, killed).length === 0) return;
    if (Date.now() >= deadline) return;
  }
}

function trySignal(deps: TreeStopDeps, pid: number, name: NodeJS.Signals): void {
  try {
    (deps.signal ?? posixSignal)(pid, name);
  } catch {
    // Процесса уже нет или он не наш по правам — остаток покажет повторный снимок.
  }
}
