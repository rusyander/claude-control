import { join } from 'node:path';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { LiveTask } from '../../journal/resume.ts';
import type { SplitEnv } from '../estimate/estimate.types.ts';
import type { TaskRegistry } from '../tasks.ts';
import { XL_CHILDREN_SIGNAL } from './children.ts';
import { latestSplit } from './journal-view.ts';
import type { ProposedUnit } from './split.types.ts';
import type { XlChild, XlChildEnd, XlChildren } from './xl-wait.ts';

/**
 * Порт детей XL исполнителю (Q-2 s11): что о детях знают журнал родителя (последнее деление,
 * его порядок, сигналы `xl-children` волн) и журналы детей (`task.ended`, причина конца), и
 * запуск следующей волны тем же путём оценки (`createChildTasks` через `SplitEnv.childTasks`).
 * Суд — `xl-wait.ts`; здесь только чтение и запуск.
 */

/** Как часто родитель без живой сессии смотрит на детей (стена). */
export const XL_POLL_MS = 30_000;

export interface XlChildrenDeps {
  registry: TaskRegistry;
  childTasks: NonNullable<SplitEnv['childTasks']>;
  pollMs?: number;
  note?(event: string, data: Record<string, unknown>): void;
}

interface Wave {
  byName?: Record<string, string>;
  refused?: Record<string, string>;
}

/** Деление родителя и его волны: перечитывается, только когда журнал родителя сдвинулся. */
interface ParentFacts {
  seq: number;
  splitId: string;
  ordered: ProposedUnit[];
  byName: Map<string, string>;
  refused: Map<string, string>;
}

function parentFacts(task: LiveTask): ParentFacts | null {
  const lines = readJournalLines(task.dir, task.taskId).lines as JournalLine[];
  const split = latestSplit(lines);
  const decision = split?.decision;
  if (!split || !decision || decision.verdict !== 'accepted') return null;
  const byName = new Map<string, string>();
  const refused = new Map<string, string>();
  let waves = 0;
  for (const l of lines) {
    if (l.kind !== 'signal') continue;
    const d = (l as JournalLine<'signal'>).data;
    if (d.signal !== XL_CHILDREN_SIGNAL || d.subject !== split.splitId) continue;
    let wave: Wave;
    try {
      wave = JSON.parse(d.detail ?? '{}') as Wave;
    } catch {
      continue;
    }
    // Сигнал до Q-2 имён не несёт: такой родитель кончается на запуске, как раньше.
    if (!wave.byName) continue;
    waves += 1;
    for (const [name, id] of Object.entries(wave.byName)) {
      byName.set(name, id);
      refused.delete(name);
    }
    for (const [name, why] of Object.entries(wave.refused ?? {}))
      if (!byName.has(name)) refused.set(name, why);
  }
  if (waves === 0) return null;
  const ordered = decision.order.flatMap((n) => split.units.filter((u) => u.name === n));
  return { seq: task.state.seq, splitId: split.splitId, ordered, byName, refused };
}

/** Причина конца ребёнка: последнее решение `next` `fail-task`/`cancel-task` его журнала. */
function endReasonOf(registry: TaskRegistry, taskId: string): string | null {
  const lines = readJournalLines(join(registry.tasksDir, taskId), taskId).lines as JournalLine[];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const l = lines[i]!;
    if (l.kind !== 'decision') continue;
    const out = (l as JournalLine<'decision'>).data.output as {
      kind?: string;
      reason?: string;
    } | null;
    if (out && (out.kind === 'fail-task' || out.kind === 'cancel-task') && out.reason)
      return out.reason;
  }
  return null;
}

/** Задача — родитель XL с уже запущенным делением (иначе порт молчит и чтения нет). */
function mayBeParent(task: LiveTask): boolean {
  const created = task.state.created;
  if (!created?.lead || created.parentTaskId) return false;
  if (task.state.lead?.taskClass?.class !== 'XL') return false;
  return Object.values(task.state.splits).some(
    (s) => s.state !== 'proposed' && s.state !== 'refused',
  );
}

export function xlChildrenPort(deps: XlChildrenDeps): {
  childrenOf(task: LiveTask): XlChildren | null;
  launch(task: LiveTask, names: readonly string[]): Promise<void>;
} {
  const facts = new Map<string, ParentFacts | null>();
  const seen = new Map<string, number>();
  const ends = new Map<string, { ended: XlChildEnd; why: string | null }>();
  const factsOf = (task: LiveTask): ParentFacts | null => {
    if (seen.get(task.taskId) === task.state.seq) return facts.get(task.taskId) ?? null;
    const got = parentFacts(task);
    facts.set(task.taskId, got);
    seen.set(task.taskId, task.state.seq);
    return got;
  };
  const endOf = (taskId: string): { ended: XlChildEnd | null; why: string | null } => {
    const known = ends.get(taskId);
    if (known) return known;
    const state = deps.registry.view(taskId);
    // Ребёнка нет в этом ядре (журнал убран): ждать его вечно нельзя — он не сдан.
    if (!state) return { ended: 'failed', why: 'child task not found' };
    if (state.ended === null) return { ended: null, why: null };
    const end = {
      ended: state.ended,
      why: state.ended === 'done' ? null : endReasonOf(deps.registry, taskId),
    };
    ends.set(taskId, end);
    return end;
  };
  return {
    childrenOf(task) {
      if (!mayBeParent(task)) return null;
      const f = factsOf(task);
      if (!f) return null;
      const children: XlChild[] = f.ordered.map((u) => {
        const taskId = f.byName.get(u.name) ?? null;
        const end = taskId ? endOf(taskId) : { ended: null, why: null };
        return {
          name: u.name,
          deps: u.deps,
          taskId,
          refused: f.refused.get(u.name) ?? null,
          ended: end.ended,
          why: end.why,
        };
      });
      return { children, pollMs: deps.pollMs ?? XL_POLL_MS };
    },
    async launch(task, names) {
      const f = factsOf(task);
      if (!f) return;
      let made: Awaited<ReturnType<XlChildrenDeps['childTasks']>>;
      try {
        made = await deps.childTasks(task, f.splitId, f.ordered, names);
      } catch (error) {
        // Сбой создания — отказ этих частей, названный: иначе суд звал бы запуск без конца.
        const why = error instanceof Error ? error.message : String(error);
        made = {
          taskIds: [],
          problems: names.map((n) => `${n}: ${why}`),
          byName: {},
          refused: Object.fromEntries(names.map((n) => [n, why])),
        };
      }
      task.append({
        kind: 'signal',
        actor: 'core',
        data: {
          signal: XL_CHILDREN_SIGNAL,
          severity: made.problems.length > 0 ? 'warn' : 'info',
          subject: f.splitId,
          detail: JSON.stringify({ byName: {}, refused: {}, ...made }),
        },
      });
      deps.note?.('xl.children-launched', { taskId: task.taskId, names: [...names] });
    },
  };
}
