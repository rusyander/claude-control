import { join } from 'node:path';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import type { SessionHandle } from '../../adapters/index.ts';
import type { StopOutcome } from '../../adapters/launcher/launcher.types.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { factReason, hasValue, type Fact } from '../../platform/os-kind.ts';
import { releaseByKind, releaseRow } from '../../conductor/services.ts';
import { dirtyPaths } from '../../platform/copy-git.ts';
import { snapshotDir, type OwnedListener } from '../../platform/resource-scan.ts';
import { pathKey } from '../../platform/paths.ts';
import { readSessionState, writeSessionState } from './core-state.ts';
import type { ResourceReaders } from './resource-readers.ts';
import type { FoundResource, TaskRelease } from './road.types.ts';
import { readCalls, refusalOf } from './unlabelled.ts';

/**
 * Ресурсы сессии (01 §Resources, P90, P40): что сессия создала сама — НАЙДЕНО, а не взято на
 * веру. Снимок до запуска (рабочие копии git, помеченные контейнеры) держит дорога в памяти и
 * в доме ядра с отпечатком в журнале (`core-state.ts`) — прикреплённая заново сессия сравнивает
 * с тем же снимком, а сама сессия его не подменит. На остановке: порты дерева
 * и найденных по метке — ДО остановки (после неё владельцев нет), временный каталог, новые
 * рабочие копии и контейнеры, пережившие остановку процессы — после. Каждая находка — строка
 * `resource.created {owner:'session', release:'task-end'}`; непрочитанный снимок назван, а не
 * считан пустым (F25). В конце задачи каждая находка снимается и читается назад.
 */

/** Имя снимка в доме ядра (`core-state.ts`), не в каталоге сессии — его пишет сессия. */
export const BASELINE_FILE = 'resources-baseline.json';
/** Сигнал журнала: снимок конца шага прочитан не весь (причины через `; `). */
export const UNREAD_SIGNAL = 'resources-unread';

export { REAL_READERS, type ResourceReaders } from './resource-readers.ts';

export interface Baseline {
  worktrees: string[] | null;
  containers: Record<string, string[] | null>;
  /** Поды с меткой задачи до сессии (только podman); нет поля — снимок прежнего вида. */
  pods?: Record<string, string[] | null>;
  /** Все контейнеры / поды движка до сессии; `null` — не прочитано. */
  all?: Record<string, string[] | null>;
  allPods?: Record<string, string[] | null>;
  engines: string[];
  cwd: string;
}

const listOf = (got: Fact<string[]>): string[] | null => (hasValue(got) ? got.value : null);

/** Снимок до запуска: в память дороги (ответ) и в дом ядра с отпечатком в журнале. */
export async function takeBaseline(
  input: { task: LiveTask; sessionId: string; stateDir: string; cwd: string; engines: string[] },
  readers: ResourceReaders,
): Promise<Baseline> {
  const { taskId } = input.task;
  const trees = await readers.worktrees(input.cwd);
  const containers: Baseline['containers'] = {};
  const pods: Record<string, string[] | null> = {};
  const all: Record<string, string[] | null> = {};
  const allPods: Record<string, string[] | null> = {};
  for (const engine of input.engines) {
    const got = await readers.containers(taskId, engine);
    containers[engine] = hasValue(got) ? got.value.map((c) => c.id) : null;
    all[engine] = readers.allContainers ? listOf(await readers.allContainers(engine)) : null;
    if (engine === 'podman' && readers.pods) {
      pods[engine] = listOf(await readers.pods(taskId, engine));
      allPods[engine] = readers.allPods ? listOf(await readers.allPods(engine)) : null;
    }
  }
  const baseline: Baseline = {
    worktrees: hasValue(trees) ? trees.value.map((t) => t.path) : null,
    containers,
    pods,
    all,
    allPods,
    engines: input.engines,
    cwd: input.cwd,
  };
  writeSessionState(input.task, input.stateDir, input.sessionId, BASELINE_FILE, baseline);
  return baseline;
}

/** Снимок прежнего ядра (сессия прикреплена заново): только с журнальным отпечатком. */
export function readBaseline(task: LiveTask, stateDir: string, sessionId: string): Fact<Baseline> {
  const got = readSessionState(task, stateDir, sessionId, BASELINE_FILE);
  if (!hasValue(got)) return got;
  const doc = got.value as Partial<Baseline> | null;
  const ok =
    doc !== null &&
    typeof doc === 'object' &&
    typeof doc.cwd === 'string' &&
    Array.isArray(doc.engines) &&
    typeof doc.containers === 'object';
  return ok ? { value: doc as Baseline } : { unknown: `${BASELINE_FILE}: foreign shape` };
}

type Note = (event: string, data: Record<string, unknown>) => void;

function journalFound(
  task: LiveTask,
  sessionId: string,
  kind: FoundResource['kind'],
  ref: string,
): FoundResource {
  const rid = newId();
  task.append({
    kind: 'resource.created',
    actor: 'core',
    sessionId,
    data: { rid, kind, owner: 'session', release: 'task-end', ref },
  });
  return { rid, kind, ref };
}

export interface ScanContext {
  task: LiveTask;
  handle: SessionHandle;
  tmpDir: string;
  readers: ResourceReaders;
  note: Note;
  /** Снимок до запуска — из памяти дороги или проверенный по журналу (`readBaseline`). */
  baseline: Fact<Baseline>;
  /**
   * Копии живых задач (созданы ядром): новая рабочая копия репозитория из этого списка — не
   * ресурс сессии, даже появившись за её шаг (ревью B2r4-F01: копия параллельной задачи).
   */
  liveCopies?: readonly string[];
}

/** До остановки: порты дерева хоста и процессов с меткой сессии (их владелец ещё жив). */
export async function scanBeforeStop(
  ctx: ScanContext,
  marker: { name: string; value: string },
): Promise<{ ports: OwnedListener[]; unread: string[] }> {
  const unread: string[] = [];
  const swept = await ctx.readers.sweep(marker.name, marker.value);
  if (!hasValue(swept)) unread.push(`marker sweep: ${factReason(swept)}`);
  const ports = await ctx.readers.listeners([ctx.handle.host], hasValue(swept) ? swept.value : []);
  if (!hasValue(ports)) {
    unread.push(`ports: ${factReason(ports)}`);
    return { ports: [], unread };
  }
  return { ports: ports.value, unread };
}

/** После остановки: временный каталог, новые рабочие копии и контейнеры, выжившие процессы. */
export async function scanAfterStop(
  ctx: ScanContext,
  before: { ports: OwnedListener[]; unread: string[] },
  stop: StopOutcome,
): Promise<{ found: FoundResource[]; unread: string[] }> {
  const { task, handle } = ctx;
  const sessionId = handle.sessionId;
  const unread = [...before.unread];
  const found: FoundResource[] = [];
  for (const port of before.ports) {
    found.push(
      journalFound(
        task,
        sessionId,
        'port',
        JSON.stringify({ address: port.address, port: port.port, owner: port.owner }),
      ),
    );
  }
  const tmp = snapshotDir(ctx.tmpDir);
  if (hasValue(tmp)) {
    for (const entry of tmp.value)
      found.push(journalFound(task, sessionId, 'tmpdir', join(ctx.tmpDir, entry.name)));
  } else if (!('absent' in tmp)) unread.push(`tmpdir: ${factReason(tmp)}`);

  const baseline = hasValue(ctx.baseline) ? ctx.baseline.value : undefined;
  if (!baseline) {
    unread.push(
      `baseline: not read (${factReason(ctx.baseline)}) — worktrees and containers not compared`,
    );
  }
  if (baseline) {
    if (baseline.worktrees === null) unread.push('worktrees: baseline unread');
    else {
      const now = await ctx.readers.worktrees(baseline.cwd);
      if (!hasValue(now)) unread.push(`worktrees: ${factReason(now)}`);
      else {
        const old = new Set(
          [...baseline.worktrees, ...(ctx.liveCopies ?? [])].map((p) => pathKey(p)),
        );
        for (const tree of now.value) {
          if (old.has(pathKey(tree.path))) continue;
          found.push(
            journalFound(
              task,
              sessionId,
              'copy',
              JSON.stringify({ worktree: tree.path, repo: baseline.cwd }),
            ),
          );
        }
      }
    }
    for (const engine of baseline.engines) {
      const was = baseline.containers[engine];
      if (was === null || was === undefined) {
        unread.push(`${engine}: baseline unread`);
        continue;
      }
      const now = await ctx.readers.containers(task.taskId, engine);
      if (!hasValue(now)) {
        unread.push(`${engine}: ${factReason(now)}`);
        continue;
      }
      for (const c of now.value) {
        if (was.includes(c.id)) continue;
        found.push(
          journalFound(task, sessionId, 'container', JSON.stringify({ engine, id: c.id })),
        );
      }
    }
    found.push(...(await scanUnlabelled(ctx, baseline, unread)));
  }
  // Остановка не сняла их — переродители и остаток дерева: ресурс, а не тишина.
  for (const id of stop.residual) {
    found.push(
      journalFound(task, sessionId, 'process', JSON.stringify({ pid: id.pid, start: id.start })),
    );
  }
  if (stop.unknown) unread.push(`stop: ${stop.unknown}`);
  if (unread.length > 0) {
    ctx.note('session.resources.unread', { taskId: task.taskId, sessionId, unread });
    // В журнал задачи, а не только в лог ядра (ревью A2r5-F05): конец задачи несёт это в
    // `TaskRelease.unread`, и «утечек нет» над непрочитанным не скажется.
    task.append({
      kind: 'signal',
      actor: 'core',
      sessionId,
      data: {
        signal: UNREAD_SIGNAL,
        severity: 'warn',
        subject: sessionId,
        detail: unread.join('; '),
      },
    });
  }
  return { found, unread };
}

/**
 * Контейнеры без метки задачи (G18): проект compose, названный вызовом, — всё созданное в нём
 * после первого вызова сессии (по id, не `compose down`); `kube play` — созданное за вызов; поды
 * с меткой задачи — новые против снимка. Повторы id одного прохода не задваиваются. Id из журнала
 * вызовов (его пишет дерево сессии) берётся только после `refusalOf` (`unlabelled.ts`).
 */
async function scanUnlabelled(
  ctx: ScanContext,
  baseline: Baseline,
  unread: string[],
): Promise<FoundResource[]> {
  const { task, handle } = ctx;
  const found: FoundResource[] = [];
  const seen = new Set<string>();
  const put = (engine: string, id: string, pod: boolean): void => {
    const key = `${engine}:${pod ? 'pod' : 'c'}:${id}`;
    if (seen.has(key)) return;
    seen.add(key);
    const ref = pod ? { engine, id, pod: true } : { engine, id };
    found.push(journalFound(task, handle.sessionId, 'container', JSON.stringify(ref)));
  };
  const claimed = async (engine: string, id: string, pod: boolean): Promise<void> => {
    if (seen.has(`${engine}:${pod ? 'pod' : 'c'}:${id}`)) return;
    const existed = pod ? baseline.allPods?.[engine] : baseline.all?.[engine];
    const refused = await refusalOf(
      { engine, id, pod, taskId: task.taskId, existed },
      ctx.readers.taskLabelOf,
    );
    if (refused) unread.push(refused);
    else put(engine, id, pod);
  };
  const calls = readCalls(handle.dir, baseline.engines, unread);
  const projects = new Map<string, { engine: string; project: string; before: string[] | null }>();
  for (const call of calls) {
    if (call.kind === 'compose-project') {
      const key = `${call.engine}:${call.project}`;
      if (!projects.has(key)) projects.set(key, call);
      continue;
    }
    if (call.containers === null) unread.push(`${call.engine} kube play: containers unread`);
    if (call.pods === null) unread.push(`${call.engine} kube play: pods unread`);
    for (const id of call.containers ?? []) await claimed(call.engine, id, false);
    for (const id of call.pods ?? []) await claimed(call.engine, id, true);
  }
  for (const { engine, project, before } of projects.values()) {
    if (before === null) {
      unread.push(`compose project ${project}: containers before the call unread`);
      continue;
    }
    if (!ctx.readers.projectContainers) {
      unread.push(`compose project ${project}: no reader`);
      continue;
    }
    const now = await ctx.readers.projectContainers(project, engine);
    if (!hasValue(now)) {
      unread.push(`compose project ${project}: ${factReason(now)}`);
      continue;
    }
    for (const id of now.value) if (!before.includes(id)) await claimed(engine, id, false);
  }
  for (const [engine, had] of Object.entries(baseline.pods ?? {})) {
    if (had === null || !ctx.readers.pods) {
      unread.push(`${engine} pods: baseline unread`);
      continue;
    }
    const now = await ctx.readers.pods(task.taskId, engine);
    if (!hasValue(now)) {
      unread.push(`${engine} pods: ${factReason(now)}`);
      continue;
    }
    // Поды с меткой ЭТОЙ задачи — читатель ядра по метке, не журнал сессии: берутся сразу.
    for (const id of now.value) if (!had.includes(id)) put(engine, id, true);
  }
  return found;
}

/**
 * Рабочая копия, найденная за шаг, снимается `worktree remove --force` — только если она ничья
 * другая и в ней нет несохранённого (ревью B2r4-F01): копия живой задачи (появилась за шаг, но
 * её создало ядро) и копия с грязным `status` остаются, утечкой с причиной — решает человек.
 */
async function copyKept(ref: string, liveCopies: readonly string[]): Promise<string | undefined> {
  let worktree: unknown;
  try {
    worktree = (JSON.parse(ref) as { worktree?: unknown }).worktree;
  } catch {
    return undefined;
  }
  if (typeof worktree !== 'string') return undefined;
  const key = pathKey(worktree);
  if (liveCopies.some((p) => pathKey(p) === key)) {
    return `worktree ${worktree} is a live task's copy — not removed`;
  }
  const dirty = await dirtyPaths(worktree);
  if ('absent' in dirty) return undefined;
  if (!hasValue(dirty)) {
    // Копии уже нет на диске — снятие само скажет «не в списке»; иначе грязь не прочитана.
    return 'absent' in snapshotDir(worktree)
      ? undefined
      : `worktree ${worktree}: status unread (${factReason(dirty)}) — not removed`;
  }
  if (dirty.value.length > 0) {
    return `worktree ${worktree} has ${dirty.value.length} uncommitted path(s) — left for the human`;
  }
  return undefined;
}

/**
 * Конец задачи: каждая находка сессии (`task-end`), ещё не подтверждённая снятой, снимается и
 * читается назад. Утечка прошлого прохода пробуется снова; подтверждённая — не трогается. Строка
 * снимается одним на ядро `releaseRow` + `releaseByKind` (контейнер и под — после сверки метки
 * задачи). Непрочитанные снимки шагов (`UNREAD_SIGNAL`) — в `unread`, не в тишину.
 */
export async function releaseTaskResources(
  task: LiveTask,
  guard: { liveCopies?: readonly string[] } = {},
): Promise<TaskRelease> {
  const out: TaskRelease = { verified: [], leaks: [], unread: [] };
  const lines = readJournalLines(task.dir, task.taskId).lines;
  for (const line of lines) {
    if (line.kind === 'signal') {
      const sig = (line as JournalLine<'signal'>).data;
      if (sig.signal === UNREAD_SIGNAL)
        out.unread.push({ sessionId: sig.subject, reason: sig.detail });
      continue;
    }
    if (line.kind !== 'resource.created') continue;
    const data = (line as JournalLine<'resource.created'>).data;
    if (data.owner !== 'session' || data.release !== 'task-end') continue;
    const got = await releaseRow(task, data.rid, async () => {
      const kept =
        data.kind === 'copy' ? await copyKept(data.ref, guard.liveCopies ?? []) : undefined;
      return kept ? { leak: kept } : releaseByKind(task, data);
    });
    if (got && 'verified' in got) out.verified.push({ rid: got.rid, fact: got.verified });
    else if (got && 'leak' in got) out.leaks.push({ rid: got.rid, reason: got.leak });
  }
  return out;
}
