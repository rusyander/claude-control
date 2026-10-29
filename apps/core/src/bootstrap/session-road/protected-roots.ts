import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import type { Fact } from '@agentdeck/contracts/core/facts';
import type { ProtectedRootFinding } from '@agentdeck/contracts/core/records';
import type { LiveTask } from '../../journal/resume.ts';
import type { ReadLayer } from '../../adapters/adapter.types.ts';
import { commitOf } from '../../platform/copy-git.ts';
import { git } from '../../platform/git/run.ts';
import { factReason, reasonOf } from '../../platform/os-kind.ts';
import { pathKey } from '../../platform/paths.ts';
import { listWorktrees, snapshotDir, type DirEntrySnap } from '../../platform/resource-scan.ts';
import { readBytesSync } from '../../platform/safe-io/files.ts';

/**
 * Защищённые корни на конце шага (06:105-107, P04 половина «эффект», G19): разрушающее вне
 * копии ловится по ЭФФЕКТУ, не по тексту команды. Снимок до шага и после: основная копия
 * (`git status` + HEAD), соседние копии того же репозитория (кроме своей), каталоги слоя CLI
 * по списку mtime (`ReadLayer`: каталоги обходятся, файлы учётных данных — сами). Разница —
 * `signal protected-root {severity:'stop', subject: путь}`: шаг остановлен, человеку сказано.
 * Непрочитанный корень — не «чисто»: снимок `unknown`, сравнение называет корень (F25).
 *
 * Вызов — дорога сессии (зона D, `road.ts`): снимок до шага, снимок и сравнение на конце.
 * ChatBranchGate панели переходит на этот факт в фазе 7 (10:95).
 */

export interface ProtectedRootsInput {
  /** Любая копия репозитория задачи: основная находится через `worktree list`. */
  repo: string;
  /** Копия этой задачи — её изменения — работа шага, не находка. */
  ownCopy: string;
  layer?: ReadLayer;
  /**
   * Пути, которые меняются сами (кэш CLI, копии других живых задач): абсолютные, сравниваются
   * префиксом. Решает вызывающий — переходник знает свой CLI.
   */
  volatile?: readonly string[];
  /**
   * Копии, созданные ядром (живые задачи): их ПОЯВЛЕНИЕ за шаг — не находка. Изменения внутри
   * уже бывшей копии другой задачи — находка (06:105: соседние копии защищены).
   */
  coreCopies?: readonly string[];
  /** Потолок обхода каталогов слоя: дальше — `unknown`, не «ничего не изменилось». */
  maxEntries?: number;
}

interface TreeSnap {
  head: string | null;
  /**
   * Грязный путь → `XY отпечаток`: оба знака `status --porcelain` (индекс и рабочее дерево —
   * `git add` в основной копии тоже запись) и отпечаток содержимого. Буквы мало: уже грязный
   * файл человека, удалённый или опустошённый шагом, остаётся `M` (ревью A2-F01, B2r4-F03).
   */
  status: Record<string, string>;
}

export interface ProtectedRootsSnapshot {
  main: { path: string } & TreeSnap;
  siblings: Record<string, TreeSnap>;
  /** Путь → `mtimeMs:size`; каталог — тоже строкой (добавление/удаление внутри меняет его mtime). */
  config: Record<string, string>;
}

/** Файл крупнее — отпечаток `mtime:size`, не хэш: снимок шага не читает гигабайты. */
const HASH_CAP = 8 * 1024 * 1024;

/** `status --porcelain -z --no-renames`: `XY путь` на запись, переименование — две записи. */
function parseStatusXY(stdout: string): { xy: string; path: string }[] {
  return stdout
    .split('\0')
    .filter((entry) => entry.length >= 4)
    .map((entry) => ({ xy: entry.slice(0, 2), path: entry.slice(3) }));
}

/** Отпечаток содержимого каждого пути; непрочитанный файл — `unknown` всего снимка (P44). */
function stampsOf(root: string, paths: readonly string[]): Fact<Record<string, string>> {
  const dirs = new Map<string, Fact<Map<string, DirEntrySnap>>>();
  const rowsOf = (dir: string): Fact<Map<string, DirEntrySnap>> => {
    let got = dirs.get(dir);
    if (!got) {
      const rows = snapshotDir(dir);
      got = 'value' in rows ? { value: new Map(rows.value.map((r) => [r.name, r])) } : rows;
      dirs.set(dir, got);
    }
    return got;
  };
  const out: Record<string, string> = {};
  for (const rel of paths) {
    const abs = join(root, rel);
    const rows = rowsOf(dirname(abs));
    if ('unknown' in rows) return { unknown: `${abs}: ${rows.unknown}` };
    const row = 'value' in rows ? rows.value.get(basename(abs)) : undefined;
    if (!row) {
      out[rel] = 'absent';
      continue;
    }
    if (row.kind !== 'file' || row.size > HASH_CAP) {
      out[rel] = `${row.kind}:${row.mtimeMs}:${row.size}`;
      continue;
    }
    const bytes = readBytesSync(abs);
    if ('unknown' in bytes) return { unknown: `${abs}: ${bytes.unknown}` };
    out[rel] =
      'value' in bytes
        ? `sha256:${createHash('sha256').update(bytes.value).digest('hex')}`
        : 'absent';
  }
  return { value: out };
}

async function treeSnap(dir: string): Promise<Fact<TreeSnap>> {
  const head = await commitOf(dir, 'HEAD');
  if ('unknown' in head) return { unknown: `${dir}: HEAD: ${head.unknown}` };
  let rows: { xy: string; path: string }[];
  try {
    const out = await git(dir, ['status', '--porcelain=v1', '-z', '-uall', '--no-renames'], {
      timeoutMs: 30_000,
    });
    rows = parseStatusXY(out.stdout);
  } catch (error) {
    return { unknown: `${dir}: status: ${reasonOf(error)}` };
  }
  const stamps = stampsOf(
    dir,
    rows.map((r) => r.path),
  );
  if (!('value' in stamps)) return { unknown: `${dir}: content: ${factReason(stamps)}` };
  const status: Record<string, string> = {};
  for (const row of rows) status[row.path] = `${row.xy} ${stamps.value[row.path] ?? 'absent'}`;
  return { value: { head: 'value' in head ? head.value : null, status } };
}

function under(path: string, prefixes: readonly string[]): boolean {
  const key = pathKey(path);
  return prefixes.some((p) => {
    const k = pathKey(p);
    return key === k || key.startsWith(`${k}/`) || key.startsWith(`${k}\\`);
  });
}

/** Список mtime каталогов слоя: обход вглубь через платформу (сам модуль файловой системы не трогает). */
function configSnap(
  layer: ReadLayer,
  volatile: readonly string[],
  maxEntries: number,
): Fact<Record<string, string>> {
  const out: Record<string, string> = {};
  let count = 0;
  const stack = layer.dirs.filter((d) => !under(d, volatile));
  for (const root of stack) out[root] = 'root';
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    const rows = snapshotDir(dir);
    if ('absent' in rows) {
      out[dir] = 'absent';
      continue;
    }
    if ('unknown' in rows) return { unknown: `${dir}: ${rows.unknown}` };
    for (const row of rows.value) {
      const path = join(dir, row.name);
      if (under(path, volatile)) continue;
      count += 1;
      if (count > maxEntries) return { unknown: `config dirs: more than ${maxEntries} entries` };
      if (row.kind === 'dir') {
        out[path] = 'dir';
        stack.push(path);
      } else out[path] = `${row.mtimeMs}:${row.size}`;
    }
  }
  for (const file of layer.credentials) {
    if (under(file, volatile)) continue;
    const parent = dirname(file);
    const name = file.slice(parent.length).replace(/^[\\/]/, '');
    const rows = snapshotDir(parent);
    if ('unknown' in rows) return { unknown: `${file}: ${rows.unknown}` };
    const row = 'value' in rows ? rows.value.find((r) => r.name === name) : undefined;
    out[file] = row ? `${row.mtimeMs}:${row.size}` : 'absent';
  }
  return { value: out };
}

export async function snapshotProtectedRoots(
  input: ProtectedRootsInput,
): Promise<Fact<ProtectedRootsSnapshot>> {
  try {
    const trees = await listWorktrees(input.repo);
    if (!('value' in trees))
      return { unknown: `worktree list: ${'unknown' in trees ? trees.unknown : 'absent'}` };
    const [main, ...rest] = trees.value;
    if (!main) return { unknown: 'worktree list: empty' };
    const volatile = input.volatile ?? [];
    const own = pathKey(input.ownCopy);
    const mainSnap = await treeSnap(main.path);
    if (!('value' in mainSnap)) return mainSnap as Fact<never>;
    const siblings: Record<string, TreeSnap> = {};
    for (const tree of rest) {
      if (tree.bare || tree.prunable || pathKey(tree.path) === own || under(tree.path, volatile)) {
        continue;
      }
      const snap = await treeSnap(tree.path);
      if (!('value' in snap)) return snap as Fact<never>;
      siblings[tree.path] = snap.value;
    }
    let config: Record<string, string> = {};
    if (input.layer) {
      const got = configSnap(input.layer, volatile, input.maxEntries ?? 50_000);
      if (!('value' in got)) return got as Fact<never>;
      config = got.value;
    }
    return { value: { main: { path: main.path, ...mainSnap.value }, siblings, config } };
  } catch (error) {
    return { unknown: reasonOf(error) };
  }
}

function treeFindings(
  root: ProtectedRootFinding['root'],
  path: string,
  before: TreeSnap,
  after: TreeSnap | undefined,
): ProtectedRootFinding[] {
  // Соседняя копия пропала (её сняли) — это удаление корня.
  if (!after) return [{ root, path, change: 'removed' }];
  const out: ProtectedRootFinding[] = [];
  if (before.head !== after.head) out.push({ root, path, change: 'head' });
  for (const rel of new Set([...Object.keys(before.status), ...Object.keys(after.status)])) {
    if (before.status[rel] === after.status[rel]) continue;
    out.push({ root, path: `${path}/${rel}`, change: 'status' });
  }
  return out;
}

export function compareProtectedRoots(
  before: ProtectedRootsSnapshot,
  after: ProtectedRootsSnapshot,
): ProtectedRootFinding[] {
  const out = treeFindings('main-checkout', before.main.path, before.main, after.main);
  for (const [path, snap] of Object.entries(before.siblings)) {
    out.push(...treeFindings('sibling-copy', path, snap, after.siblings[path]));
  }
  for (const path of Object.keys(after.siblings)) {
    if (!(path in before.siblings)) out.push({ root: 'sibling-copy', path, change: 'added' });
  }
  for (const [path, stamp] of Object.entries(before.config)) {
    const now = after.config[path];
    if (now === undefined) out.push({ root: 'config-dir', path, change: 'removed' });
    else if (now !== stamp) {
      out.push({ root: 'config-dir', path, change: now === 'absent' ? 'removed' : 'mtime' });
    }
  }
  for (const path of Object.keys(after.config)) {
    if (!(path in before.config)) out.push({ root: 'config-dir', path, change: 'added' });
  }
  // Один путь — одна находка (`status` пути и `mtime` его каталога не дублируются по корню).
  const seen = new Set<string>();
  return out.filter((f) => {
    const key = `${f.root}\0${f.path}\0${f.change}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Конец шага: сравнение и сигналы. Снимок не прочитался — сигнал `protected-root-unread`
 * (`warn`; `stop`, если вызывающий знает, что снимок был и пропал): «не изменилось» без чтения
 * не говорится. Ответ — находки; шаг останавливает вызывающий по любому `stop`.
 */
export async function protectedRootsAtStepEnd(
  task: LiveTask,
  before: Fact<ProtectedRootsSnapshot>,
  input: ProtectedRootsInput,
  options: { stepId?: string; unitId?: string; unreadSeverity?: 'warn' | 'stop' } = {},
): Promise<Fact<ProtectedRootFinding[]>> {
  const { unreadSeverity = 'warn', ...scope } = options;
  const after = await snapshotProtectedRoots(input);
  if (!('value' in before) || !('value' in after)) {
    const reason = !('value' in before)
      ? `before: ${'unknown' in before ? before.unknown : 'absent'}`
      : `after: ${'unknown' in after ? after.unknown : 'absent'}`;
    task.append({
      kind: 'signal',
      actor: 'core',
      ...scope,
      data: {
        signal: 'protected-root-unread',
        severity: !('value' in before) ? unreadSeverity : 'warn',
        subject: input.repo,
        detail: reason,
      },
    });
    return { unknown: reason };
  }
  // Изменчивое на конце шага шире, чем до него: копия своей задачи, ставшая живой за шаг,
  // меняется её работой — не находка; копия, которую за шаг создало ядро для другой задачи, —
  // не «добавлена». Основная копия изменчивой не бывает — кроме случая, когда шаг идёт в ней
  // самой (копий ещё нет, G7): тогда её изменения — работа шага, как у своей копии.
  const volatile = input.volatile ?? [];
  const coreCopies = (input.coreCopies ?? []).map((p) => pathKey(p));
  const mainIsOwn = pathKey(before.value.main.path) === pathKey(input.ownCopy);
  const findings = compareProtectedRoots(before.value, after.value).filter((f) => {
    if (f.root === 'main-checkout') return !mainIsOwn;
    if (f.change === 'added' && coreCopies.includes(pathKey(f.path))) return false;
    return !under(f.path, volatile);
  });
  for (const f of findings) {
    task.append({
      kind: 'signal',
      actor: 'core',
      ...scope,
      data: {
        signal: 'protected-root',
        severity: 'stop',
        subject: f.path,
        detail: `${f.root}: ${f.change}`,
      },
    });
  }
  return { value: findings };
}
