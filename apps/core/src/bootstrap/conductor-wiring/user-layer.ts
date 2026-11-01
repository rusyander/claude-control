import type { JournalLine } from '@agentdeck/contracts/core/journal';
import type { TaskFoldState } from '../../journal/reduce/reduce.types.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { ConductorHooks } from '../../conductor/run/run.types.ts';
import { HOOK_BLOCK_SIGNAL } from '../../observer/hook-block.ts';
import { HOOK_LOOP_SIGNAL } from '../../observer/hook-loop.ts';
import type { ConductorWiringDeps } from './conductor-wiring.types.ts';

/**
 * Зона S этапа 7 — слой человека в дирижёре (06:121-122, «шаг подстраивается»): следующему шагу
 * той же единицы бриф называет хуки человека, которые отказывали в прошлых шагах, и чему они
 * отказали, — сессия обходит стену, а не бьётся в неё снова. Раздел `handoff`: это передача от
 * прошлых шагов, своего id у слоя нет. Ничего не останавливает: остановку петли решает сигнал
 * `hook-loop` в журнале (свёртка → `step.stops`).
 */

const MODULE = 'observer/hook-block';
/** Строк в разделе: хуков у человека немного, длинный список брифа не помогает. */
const ROWS_MAX = 10;

export function hookBriefOf(
  lines: readonly JournalLine[],
  state: TaskFoldState,
  unitId: string,
  stepId: string,
): string | null {
  const rows = new Map<string, { subject: string; detail: string; count: number; loop: boolean }>();
  for (const line of lines) {
    if (line.kind !== 'signal' || !line.stepId || line.stepId === stepId) continue;
    const step = Object.hasOwn(state.steps, line.stepId) ? state.steps[line.stepId] : undefined;
    if (!step || step.unitId !== unitId) continue;
    const d = (line as JournalLine<'signal'>).data;
    if (d.signal === HOOK_LOOP_SIGNAL) {
      for (const row of rows.values()) if (row.subject === d.subject) row.loop = true;
      continue;
    }
    if (d.signal !== HOOK_BLOCK_SIGNAL) continue;
    const key = `${d.subject}\0${d.detail}`;
    const row = rows.get(key);
    if (row) row.count += 1;
    else rows.set(key, { subject: d.subject, detail: d.detail, count: 1, loop: false });
  }
  if (rows.size === 0) return null;
  const all = [...rows.values()];
  const shown = all
    .slice(0, ROWS_MAX)
    .map(
      (r) =>
        `- ${r.subject}: ${r.detail}${r.count > 1 ? ` (${r.count}x)` : ''}${r.loop ? ' — stopped the step as a loop' : ''}`,
    );
  if (all.length > ROWS_MAX) shown.push(`- … ${all.length - ROWS_MAX} more`);
  return [
    "The user's own hooks refused these actions in earlier steps of this unit. Do not repeat them as they were; reach the goal another way or name the blocker in step_done:",
    ...shown,
  ].join('\n');
}

export function userLayerHooks(deps: ConductorWiringDeps): ConductorHooks {
  return {
    async preStep(s) {
      const task = deps.registry.live(s.taskId);
      if (!task) return { verdict: { ok: true }, sections: [] };
      const text = hookBriefOf(
        readJournalLines(task.dir, task.taskId).lines,
        task.state,
        s.unitId,
        s.stepId,
      );
      return {
        verdict: { ok: true },
        sections: text ? [{ id: 'handoff', text, from: MODULE }] : [],
      };
    },
  };
}
