import type { JournalDataV1 } from '@agentdeck/contracts/core/journal';
import type { StepEvent, StepState, TaskEvent, TaskState } from '@agentdeck/contracts/core/states';
import { CREATED, SOLO_UNIT } from '../../../journal/__fixtures__/journal-harness.ts';
import type { LiveTask } from '../../../journal/resume.ts';
import { newId } from '../../../lib/ids/uuidv7.ts';
import type { TaskRegistry } from '../../tasks.ts';

/**
 * Настоящие задачи для доски (этап 12, B2/B3): задача создаётся настоящим реестром, её факты —
 * настоящими строками журнала через `LiveTask.append` (машины состояний свёртки их судят). Так
 * тест ставит задачу в любую стадию без модели; полный прогон на заглушке — сквозной QA (W1-D).
 */

export function newTask(
  registry: TaskRegistry,
  over: Partial<JournalDataV1['task.created']> = {},
): Promise<LiveTask> {
  return registry.create({ ...CREATED, scenario: { id: 'feature', version: 1 }, ...over });
}

export function go(t: LiveTask, event: TaskEvent, from: TaskState, to: TaskState): void {
  t.append({
    kind: 'task.transition',
    actor: 'core',
    data: { taskId: t.state.taskId, event, from, to },
  });
}

export function running(t: LiveTask): void {
  go(t, 'estimate', 'draft', 'estimating');
  go(t, 'estimated', 'estimating', 'awaiting-launch');
  go(t, 'launch', 'awaiting-launch', 'running');
}

/** Отмена идущей задачи с отчётом конца — так её кончает настоящая команда `cancel`. */
export function cancelled(t: LiveTask): void {
  go(t, 'cancel', 'running', 'cancelled');
  t.append({ kind: 'task.ended', actor: 'core', data: { outcome: 'cancelled' } });
}

export function unit(t: LiveTask, splitId: string | null = null): string {
  const unitId = newId();
  t.append({
    kind: 'unit.created',
    actor: 'core',
    unitId,
    data: {
      ...SOLO_UNIT,
      unitId,
      repoKey: 'r1',
      branch: `b-${unitId.slice(-6)}`,
      ownedPaths: [],
      splitId,
    },
  });
  return unitId;
}

export function step(t: LiveTask, unitId: string, kind: string, to: StepState = 'running'): string {
  const stepId = newId();
  t.append({
    kind: 'step.started',
    actor: 'core',
    unitId,
    stepId,
    data: {
      stepId,
      unitId,
      stepKind: kind as never,
      stepDefId: kind,
      round: 0,
      scenario: { id: 'feature', version: 1 },
      budgetMs: 600_000,
    },
  });
  const tr = (event: StepEvent, from: StepState, next: StepState) =>
    t.append({
      kind: 'step.transition',
      actor: 'core',
      stepId,
      data: { stepId, event, from, to: next },
    });
  if (to === 'queued') return stepId;
  tr('start', 'queued', 'running');
  if (to === 'done') {
    tr('check', 'running', 'checking');
    tr('checked-green', 'checking', 'done');
  }
  return stepId;
}

/** Вопрос человеку: `defaultAction === null` — блокирующий (P153). */
export function ask(t: LiveTask, defaultAction: string | null): string {
  const askId = newId();
  t.append({
    kind: 'human.asked',
    actor: 'core',
    data: {
      askId,
      point: 8,
      source: 'scenario-step',
      dedupe: null,
      question: 'q',
      options: [],
      defaultAction,
    },
  });
  return askId;
}

export function answered(t: LiveTask, askId: string): void {
  t.append({
    kind: 'human.answered',
    actor: 'human:panel',
    data: { askId, answer: 'go on', channel: 'panel' },
  });
  t.append({
    kind: 'ask.transition',
    actor: 'core',
    data: { askId, event: 'answer', from: 'open', to: 'answered' },
  });
}

/** Открытый сеанс модели у задачи (`session.started` → состояние `starting`, открытое). */
export function session(t: LiveTask): string {
  const sessionId = newId();
  t.append({
    kind: 'session.started',
    actor: 'core',
    sessionId,
    data: {
      sessionId,
      stepId: newId(),
      adapter: 'a-1',
      cliVersion: '1',
      route: { kind: 'cli-login', id: 'login' },
      hops: [],
      credentialKind: 'none',
      modelAsked: null,
      modelServed: null,
      effort: null,
      hostPid: process.pid,
      hostStart: 'start',
      cliPid: null,
      cliStart: null,
      cwd: '/w',
      argv: [],
      resumeOf: null,
      cacheAgeMs: null,
    },
  });
  return sessionId;
}
