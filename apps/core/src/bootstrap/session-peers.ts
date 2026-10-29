import type { TaskFoldState } from '../journal/reduce/reduce.types.ts';
import type { TaskRegistry } from '../conductor/tasks.ts';
import type { ProcessIdentity, ProcessTableSource } from '../platform/process-table.ts';
import { descendantsOf } from '../platform/tree-stop.ts';

/**
 * Входит ли звонящий в дерево какой-либо сессии (06 §Authority, ревью F-15). Корни — хост и CLI
 * каждой сессии из журналов задач (личность pid + старт от ОС); дерево строит само ядро по
 * снимку таблицы процессов. Снимка нет, журнал задачи не прочитан или звонящего нет в снимке —
 * `unknown`: строгая команда тогда требует подписи устройства. Никогда не «чисто» по догадке.
 */

export type SessionRoots = { value: ProcessIdentity[] } | { unknown: string };

export interface SessionPeerDeps {
  roots(): SessionRoots;
  table: ProcessTableSource;
  /** pid самого ядра: в дерево сессии он не входит (ядро — не ребёнок хоста). */
  selfPid?: number;
}

function rootsOfState(state: TaskFoldState): ProcessIdentity[] {
  const out: ProcessIdentity[] = [];
  for (const session of Object.values(state.sessions)) {
    // Состояние сессии не фильтруется: мёртвый корень дерева не даёт (старт не совпадёт), а
    // «кончившаяся» по журналу сессия могла оставить живого CLI — его дети тоже не человек.
    out.push({ pid: session.hostPid, start: session.hostStart });
    if (session.cliPid !== null && session.cliStart !== null) {
      out.push({ pid: session.cliPid, start: session.cliStart });
    }
  }
  return out;
}

/** Корни сессий всех незаконченных задач дома: живых (своя свёртка) и чужих (чтение журнала). */
export function sessionRootsOf(registry: TaskRegistry): SessionRoots {
  try {
    const roots: ProcessIdentity[] = [];
    for (const summary of registry.list()) {
      const live = registry.live(summary.taskId);
      if (live) {
        roots.push(...rootsOfState(live.state));
        continue;
      }
      if (summary.ended !== null) continue;
      const view = registry.view(summary.taskId);
      if (!view) return { unknown: `task ${summary.taskId} vanished while reading roots` };
      roots.push(...rootsOfState(view));
    }
    return { value: roots };
  } catch (error) {
    return { unknown: error instanceof Error ? error.message : String(error) };
  }
}

export function createSessionPeerCheck(
  deps: SessionPeerDeps,
): (pid: number) => Promise<boolean | 'unknown'> {
  const selfPid = deps.selfPid ?? process.pid;
  return async (pid) => {
    const roots = deps.roots();
    if (!('value' in roots)) return 'unknown';
    // Сессий нет ни в одном журнале — дерева нет, читать таблицу незачем.
    if (roots.value.length === 0) return false;
    const table = await deps.table.read();
    if (!('value' in table)) return 'unknown';
    const rows = table.value;
    // Звонящего нет в снимке (вышел, снимок неполон) — его предков не узнать.
    if (!rows.some((row) => row.pid === pid)) return 'unknown';
    for (const root of roots.value) {
      if (descendantsOf(rows, root, selfPid).some((row) => row.pid === pid)) return true;
    }
    return false;
  };
}
