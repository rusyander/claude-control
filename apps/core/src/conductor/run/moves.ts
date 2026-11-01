import type { JournalDataV1 } from '@agentdeck/contracts/core/journal';
import type { Scenario, ScenarioRef, StepDef } from '@agentdeck/contracts/core/scenario';
import {
  STEP_MACHINE,
  TASK_MACHINE,
  UNIT_MACHINE,
  nextState,
  taskEndedOutcome,
  type StepEvent,
  type TaskEvent,
  type UnitEvent,
} from '@agentdeck/contracts/core/states';
import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { END_REASON } from '../next/next.types.ts';
import type {
  BriefSection,
  HookVerdict,
  LiveSession,
  RunDeps,
  StepCtx,
  UnitCtx,
} from './run.types.ts';

/**
 * Примитивы исполнителя: переходы машин и строки журнала одного действия. Каждое «если» только
 * проверяет, что машина ещё допускает событие (повтор после перезапуска не пишет второй переход).
 * Делят их `perform.ts` и `core-step.ts`.
 */

export interface PerformCtx {
  task: LiveTask;
  deps: RunDeps;
  scenario: Scenario;
  /** Сценарий новых шагов: ожидающая правка (G11) применяется со следующего шага. */
  ref: ScenarioRef;
  live: Map<string, LiveSession>;
  /**
   * Открыть сессию шага и отдать ей первое сообщение (бриф или дельту, этап 5): живые события
   * приходят в цикл (`run.ts`). Ответ — `null` или причина, по которой сессии нет.
   */
  openSession(s: StepCtx, sections: BriefSection[]): Promise<string | null>;
  /** Отказы дороги подряд по шагу (Q1): счёт в памяти процесса, сбрасывается открытой сессией. */
  refusals: Map<string, number>;
}

export function stepMove(
  task: LiveTask,
  stepId: string,
  event: StepEvent,
  cause?: number,
): boolean {
  const from = task.state.steps[stepId]?.state;
  if (!from) return false;
  const moved = nextState(STEP_MACHINE, from, event);
  if (!moved.ok) return false;
  task.append({
    kind: 'step.transition',
    actor: 'core',
    stepId,
    ...(cause === undefined ? {} : { cause }),
    data: { stepId, event, from, to: moved.to },
  });
  return true;
}

export function unitMove(task: LiveTask, unitId: string, event: UnitEvent): boolean {
  const from = task.state.units[unitId]?.state;
  if (!from) return false;
  const moved = nextState(UNIT_MACHINE, from, event);
  if (!moved.ok) return false;
  task.append({
    kind: 'unit.transition',
    actor: 'core',
    unitId,
    data: { unitId, event, from, to: moved.to },
  });
  return true;
}

export function taskMove(task: LiveTask, event: TaskEvent): void {
  const from = task.state.task;
  const moved = nextState(TASK_MACHINE, from, event);
  if (!moved.ok) return;
  const line = task.append({
    kind: 'task.transition',
    actor: 'core',
    data: { taskId: task.taskId, event, from, to: moved.to },
  });
  const ended = taskEndedOutcome(moved.to);
  if (ended) {
    task.append({ kind: 'task.ended', actor: 'core', cause: line.seq, data: { outcome: ended } });
  }
}

export function stepEnded(
  task: LiveTask,
  stepId: string,
  outcome: JournalDataV1['step.ended']['outcome'],
  basis: JournalDataV1['step.ended']['basis'],
  reason: string,
): void {
  if (task.state.steps[stepId]?.outcome !== undefined) return;
  task.append({
    kind: 'step.ended',
    actor: 'core',
    stepId,
    data: { stepId, outcome, basis, reason: reason.slice(0, 2000) },
  });
}

export function defOf(scenario: Scenario, stepDefId: string): StepDef | undefined {
  return scenario.steps.find((s) => s.id === stepDefId);
}

export function unitCtx(ctx: PerformCtx, unitId: string): UnitCtx {
  const unit = ctx.task.state.units[unitId];
  return {
    taskId: ctx.task.taskId,
    unitId,
    repoKey: unit?.repoKey ?? '',
    copyDir: ctx.deps.copyDirOf?.(unitId) ?? null,
  };
}

export function stepCtx(ctx: PerformCtx, stepId: string): StepCtx | null {
  const rec = ctx.task.state.steps[stepId];
  const def = rec ? defOf(ctx.scenario, rec.stepDefId) : undefined;
  if (!rec || !def) return null;
  return {
    ...unitCtx(ctx, rec.unitId),
    stepId,
    def,
    round: rec.round,
    sessionId: ctx.live.get(stepId)?.sessionId ?? null,
  };
}

export async function endSession(
  ctx: PerformCtx,
  stepId: string,
  mode: 'soft' | 'tree',
): Promise<void> {
  const live = ctx.live.get(stepId);
  if (!live) return;
  ctx.live.delete(stepId);
  if (!live.ended) await ctx.deps.sessions.end(live.sessionId, mode);
}

/** Шаг кончается провалом: переход `fail` (если ещё допустим) и `step.ended`. */
export async function failStep(
  ctx: PerformCtx,
  stepId: string,
  reason: string,
  basis: JournalDataV1['step.ended']['basis'] = 'core',
): Promise<void> {
  await endSession(ctx, stepId, 'tree');
  stepMove(ctx.task, stepId, 'fail');
  stepEnded(ctx.task, stepId, 'failed', basis, reason);
}

/** Вердикт крючков после заявления: да — шаг готов; «шаг» — красный круг; «единица» — провал. */
export async function settle(
  ctx: PerformCtx,
  stepId: string,
  verdict: HookVerdict,
  basis: 'claimed' | 'derived' | 'core',
): Promise<void> {
  if (verdict.ok) {
    stepMove(ctx.task, stepId, 'checked-green');
    stepEnded(ctx.task, stepId, 'done', basis, `${basis}: gates green`);
    await endSession(ctx, stepId, 'soft');
    return;
  }
  const why = `${END_REASON.hook}: ${verdict.code} ${verdict.reason}`;
  if (verdict.stop === 'step') stepMove(ctx.task, stepId, 'checked-red');
  else await failStep(ctx, stepId, why);
}

export function startStep(ctx: PerformCtx, unitId: string, defId: string, round: number): string {
  const def = defOf(ctx.scenario, defId)!;
  const stepId = newId();
  ctx.task.append({
    kind: 'step.started',
    actor: 'core',
    unitId,
    stepId,
    data: {
      stepId,
      unitId,
      stepKind: def.kind,
      stepDefId: defId,
      round,
      scenario: ctx.ref,
      budgetMs: (def.budget.minutes ?? 0) * 60_000,
    },
  });
  return stepId;
}
