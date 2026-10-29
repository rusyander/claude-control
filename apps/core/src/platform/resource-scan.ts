import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { gitBaseArgs } from './encoding.ts';
import { currentOs, hasValue, reasonOf, type Fact, type OsKind } from './os-kind.ts';
import { longForm } from './paths.ts';
import { descendantsOf } from './tree-stop.ts';
import { osProcessTable, type ProcessIdentity, type ProcessTableSource } from './process-table.ts';
import { runTool } from './run-tool.ts';
import { readTcpTable, type TcpEntry } from './tcp-table.ts';

/**
 * Платформенная половина находок конца шага (01 §Resources, P90, P40): что сессия создала
 * сама — найдено, а не взято на веру. Здесь только снимки и разницы; кто и когда их
 * зовёт (начало/конец шага, журнал `resource.created`) — дело дирижёра.
 *
 * Каждый снимок — `Fact`: ОС не ответила — `unknown`, никогда не «пусто» (F25: пустая
 * разница по несработавшему снимку — ложное «ничего не осталось»).
 */

export interface Listener {
  address: string;
  port: number;
  pid?: number;
}

/** Слушающие порты машины (все владельцы). */
export async function listeningPorts(
  os: OsKind = currentOs(),
  read: (os: OsKind) => Promise<Fact<TcpEntry[]>> = readTcpTable,
): Promise<Fact<Listener[]>> {
  const table = await read(os);
  if (!hasValue(table)) return table;
  return {
    value: table.value
      .filter((row) => row.state === 'listen')
      .map((row) => ({
        address: row.localAddress,
        port: row.localPort,
        ...(row.pid !== undefined ? { pid: row.pid } : {}),
      })),
  };
}

const listenerKey = (row: Listener): string => `${row.address}|${row.port}|${row.pid ?? '?'}`;

/** Слушатели, появившиеся между двумя снимками (новый порт или новый владелец). */
export function diffListeners(before: readonly Listener[], after: readonly Listener[]): Listener[] {
  const known = new Set(before.map(listenerKey));
  return after.filter((row) => !known.has(listenerKey(row)));
}

/**
 * Порты, которые слушает дерево процесса (корень + потомки по снимку). Владелец вне
 * дерева, но новый с начала шага — это работа `diffListeners` (сирота, сбросившая метку окружения).
 */
export async function listenersOfTree(
  root: ProcessIdentity,
  source: ProcessTableSource = osProcessTable(),
  os: OsKind = currentOs(),
  read: (os: OsKind) => Promise<Fact<TcpEntry[]>> = readTcpTable,
): Promise<Fact<Listener[]>> {
  const [table, ports] = await Promise.all([source.read(), listeningPorts(os, read)]);
  if (!hasValue(table)) return table;
  if (!hasValue(ports)) return ports;
  const tree = new Set(descendantsOf(table.value, root, -1).map((row) => row.pid));
  return { value: ports.value.filter((row) => row.pid !== undefined && tree.has(row.pid)) };
}

/** Слушатель с личностью владельца (номер + старт) — снять его можно только по личности. */
export interface OwnedListener extends Listener {
  owner: ProcessIdentity;
}

/**
 * Порты, которые слушают дерево корня И процессы, найденные по метке сессии (переродители вне
 * дерева). Снимок таблицы один на оба: владелец назван личностью из него же.
 */
export async function listenersOfPids(
  roots: readonly ProcessIdentity[],
  extra: readonly ProcessIdentity[],
  source: ProcessTableSource = osProcessTable(),
  os: OsKind = currentOs(),
  read: (os: OsKind) => Promise<Fact<TcpEntry[]>> = readTcpTable,
): Promise<Fact<OwnedListener[]>> {
  const [table, ports] = await Promise.all([source.read(), listeningPorts(os, read)]);
  if (!hasValue(table)) return table;
  if (!hasValue(ports)) return ports;
  const owners = new Map<number, ProcessIdentity>();
  for (const root of roots) {
    for (const row of descendantsOf(table.value, root, -1))
      owners.set(row.pid, { pid: row.pid, start: row.start });
  }
  for (const id of extra) {
    const row = table.value.find((r) => r.pid === id.pid && r.start === id.start);
    if (row) owners.set(row.pid, { pid: row.pid, start: row.start });
  }
  const out: OwnedListener[] = [];
  for (const row of ports.value) {
    const owner = row.pid === undefined ? undefined : owners.get(row.pid);
    if (owner) out.push({ ...row, owner });
  }
  return { value: out };
}

export interface DirEntrySnap {
  name: string;
  kind: 'file' | 'dir' | 'other';
  size: number;
  mtimeMs: number;
}

/** Верхний уровень каталога (TMPDIR сессии): новое имя или изменённый файл — находка. */
export function snapshotDir(dir: string): Fact<DirEntrySnap[]> {
  // «Нет» — только по проверке до чтения (P44); пропал между проверкой и чтением — unknown.
  if (!existsSync(dir)) return { absent: true, detail: dir };
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    const rows: DirEntrySnap[] = [];
    for (const entry of entries) {
      try {
        const stat = statSync(path.join(dir, entry.name));
        rows.push({
          name: entry.name,
          kind: stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : 'other',
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        });
      } catch {
        rows.push({ name: entry.name, kind: 'other', size: 0, mtimeMs: 0 });
      }
    }
    return { value: rows };
  } catch (error) {
    return { unknown: reasonOf(error) };
  }
}

export function diffDir(
  before: readonly DirEntrySnap[],
  after: readonly DirEntrySnap[],
): { added: DirEntrySnap[]; changed: DirEntrySnap[]; removed: string[] } {
  const old = new Map(before.map((row) => [row.name, row]));
  const now = new Set(after.map((row) => row.name));
  return {
    added: after.filter((row) => !old.has(row.name)),
    changed: after.filter((row) => {
      const prev = old.get(row.name);
      return prev !== undefined && (prev.size !== row.size || prev.mtimeMs !== row.mtimeMs);
    }),
    removed: before.filter((row) => !now.has(row.name)).map((row) => row.name),
  };
}

export interface Worktree {
  path: string;
  head?: string;
  branch?: string;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
}

/** `git worktree list --porcelain -z`: записи через пустое поле, поля через NUL. */
export function parseWorktreeList(output: string, os: OsKind = currentOs()): Worktree[] {
  const trees: Worktree[] = [];
  let current: Worktree | undefined;
  for (const field of output.split('\0')) {
    if (field === '') {
      if (current) trees.push(current);
      current = undefined;
      continue;
    }
    const space = field.indexOf(' ');
    const key = space < 0 ? field : field.slice(0, space);
    const value = space < 0 ? '' : field.slice(space + 1);
    if (key === 'worktree') {
      if (current) trees.push(current);
      // git пишет `/` и на Windows — путь приводится к одному написанию ядра.
      const spelled = os === 'win32' ? value.replace(/\//g, '\\') : value;
      current = { path: spelled, detached: false, bare: false, locked: false, prunable: false };
      continue;
    }
    if (!current) continue;
    if (key === 'HEAD') current.head = value;
    else if (key === 'branch') current.branch = value;
    else if (key === 'detached') current.detached = true;
    else if (key === 'bare') current.bare = true;
    else if (key === 'locked') current.locked = true;
    else if (key === 'prunable') current.prunable = true;
  }
  if (current) trees.push(current);
  return trees;
}

export async function listWorktrees(
  repoDir: string,
  os: OsKind = currentOs(),
): Promise<Fact<Worktree[]>> {
  const run = await runTool('git', [
    ...gitBaseArgs(os),
    '-C',
    longForm(repoDir, os),
    'worktree',
    'list',
    '--porcelain',
    '-z',
  ]);
  if (!run.ok) return { unknown: `git worktree list: ${run.reason}` };
  return { value: parseWorktreeList(run.stdout, os) };
}

export interface LabelledContainer {
  id: string;
  name: string;
  state: string;
}

/** Строки `{{.ID}}\t{{.Names}}\t{{.State}}`. */
export function parseDockerPs(output: string): LabelledContainer[] {
  return (
    output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      // После trim первое поле непусто: пустой ID строкой не бывает.
      .map((line) => {
        const [id, name, state] = line.split('\t');
        return { id: id ?? '', name: name ?? '', state: state ?? '' };
      })
  );
}

/** Метка задачи, которую обёртки движков ставят на `run`/`create` сессии. */
export const TASK_LABEL = 'agentdeck.task';
/** Метка проекта, которую compose ставит каждому своему контейнеру сам. */
export const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';
/** Проект compose задачи: обёртка даёт его `compose` без своего имени проекта. */
export const composeProject = (taskId: string): string => `agentdeck-${taskId.toLowerCase()}`;

/**
 * Контейнеры задачи по метке (`--label agentdeck.task=<id>` ставят обёртки PATH сессии) и по
 * проекту compose задачи (`agentdeck-<id>`). Движка нет (`docker` не найден) или он не отвечает
 * (Docker Desktop остановлен) — `unknown`: «контейнеров нет» по молчащему движку было бы ложным
 * «убрано» (P58, F25).
 */
export async function containersByLabel(
  taskId: string,
  engine = 'docker',
  run: typeof runTool = runTool,
): Promise<Fact<LabelledContainer[]>> {
  const found = new Map<string, LabelledContainer>();
  // Фильтры `label` движок складывает через И: метка задачи и проект — двумя чтениями.
  for (const label of [
    `${TASK_LABEL}=${taskId}`,
    `${COMPOSE_PROJECT_LABEL}=${composeProject(taskId)}`,
  ]) {
    const result = await run(
      engine,
      ['ps', '-a', '--filter', `label=${label}`, '--format', '{{.ID}}\t{{.Names}}\t{{.State}}'],
      { timeoutMs: 20_000 },
    );
    if (!result.ok) {
      const reason = /ENOENT/.test(result.reason) ? 'engine-absent' : 'engine-down';
      return {
        unknown: `${reason}: ${(result.stderr ?? result.reason).trim().split(/\r?\n/)[0] ?? ''}`,
      };
    }
    for (const row of parseDockerPs(result.stdout)) if (!found.has(row.id)) found.set(row.id, row);
  }
  return { value: [...found.values()] };
}
