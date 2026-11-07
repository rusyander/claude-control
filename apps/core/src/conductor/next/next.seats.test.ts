import { describe, expect, it } from 'vitest';
import type { JournalKind, JournalLine } from '@agentdeck/contracts/core/journal';
import { initialState, reduce } from '../../journal/reduce/reduce.ts';
import type { TaskFoldState } from '../../journal/reduce/reduce.types.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { presetOf } from '../scenario/presets.ts';
import { decideNext } from './next.ts';
import type { LiveStepFact } from './next.types.ts';

/**
 * Места сеансов в суде `next` (этап 11, P141): шаг, ждущий места машины, — `wait`, а не
 * `run-step` на каждом проходе; и он не заслоняет другие единицы (суд берёт единицы по порядку).
 */

const TASK = newId();
const FEATURE = presetOf({ id: 'feature', version: 1 })!;

function fold(build: (add: (kind: JournalKind, data: unknown) => void) => void): TaskFoldState {
  let state: TaskFoldState = initialState(TASK);
  let seq = 0;
  build((kind, data) => {
    seq += 1;
    const line = { v: 1, seq, at: seq, mono: seq * 1000, bootId: TASK, taskId: TASK, kind };
    state = reduce(state, { ...line, actor: 'core', data } as JournalLine);
  });
  return state;
}

const created = {
  title: 't',
  repos: [],
  build: 'b',
  scenario: { id: 'feature', version: 1 },
  profilePins: [],
  modelCeiling: null,
  userLayerHash: null,
  envPin: '',
  requirementsSource: 'text',
  allowedRoutes: [],
  routesSourceLevel: 2,
  origin: null,
  launchPolicy: 'auto',
  ciWait: false,
};

/** Две начатые единицы, у каждой шаг `intake`; `running` — шаг уже идёт (сеанс был открыт). */
function twoUnits(running: boolean) {
  const units = [newId(), newId()];
  const steps = [newId(), newId()];
  const state = fold((add) => {
    add('task.created', created);
    add('task.transition', { taskId: TASK, event: 'launch', from: 'draft', to: 'running' });
    units.forEach((unitId, i) => {
      add('unit.created', {
        unitId,
        name: `u${i}`,
        repoKey: 'r1',
        branch: `b${i}`,
        ownedPaths: [],
        after: [],
        contract: false,
        splitId: null,
      });
      add('unit.transition', { unitId, event: 'start', from: 'planned', to: 'running' });
      add('step.started', {
        stepId: steps[i],
        unitId,
        stepKind: 'intake',
        stepDefId: 'intake',
        round: 0,
        scenario: created.scenario,
        budgetMs: 0,
      });
      if (running)
        add('step.transition', {
          stepId: steps[i],
          event: 'start',
          from: 'queued',
          to: 'running',
        });
    });
  });
  return { state, steps: steps as [string, string] };
}

const decide = (
  state: TaskFoldState,
  seats?: Record<string, string>,
  live: Record<string, LiveStepFact> = {},
) =>
  decideNext({ state, scenario: FEATURE, workNowMs: 0, live, ...(seats ? { seats } : {}) }).action;

describe('decideNext with session seats (P141)', () => {
  it('a queued step waiting for a seat does not shadow the next unit; all waiting → wait naming the seat', () => {
    const { state, steps } = twoUnits(false);
    const first = decide(state);
    expect(first).toMatchObject({ kind: 'run-step' });
    const firstId = (first as { stepId: string }).stepId;
    const other = steps.find((s) => s !== firstId)!;
    expect(decide(state, { [firstId]: 'slot' })).toEqual({ kind: 'run-step', stepId: other });
    expect(decide(state, { [firstId]: 'slot', [other]: 'route' })).toMatchObject({
      kind: 'wait',
      reason: expect.stringMatching(/^session seat: (slot|route)$/),
    });
  });

  it('a running step without a session in this process waits for its seat instead of re-running', () => {
    const { state, steps } = twoUnits(true);
    expect(decide(state, { [steps[0]]: 'slot', [steps[1]]: 'slot' })).toEqual({
      kind: 'wait',
      reason: 'session seat: slot',
    });
    expect(decide(state, { [steps[0]]: 'slot' })).toEqual({ kind: 'run-step', stepId: steps[1] });
  });

  it('a live session parked on a human ask waits for its seat: no reminder at its turn end; ended → judged as usual', () => {
    const { state, steps } = twoUnits(true);
    const sessionId = newId();
    const at = (ended: boolean): Record<string, LiveStepFact> => ({
      [steps[0]]: { sessionId, turnEnd: { seq: 7 }, ended, safe: true },
      [steps[1]]: { sessionId: newId(), turnEnd: null, ended: false, safe: false },
    });
    expect(decide(state, undefined, at(false))).toMatchObject({ kind: 'remind', stepId: steps[0] });
    expect(decide(state, { [steps[0]]: 'slot' }, at(false))).toMatchObject({
      kind: 'wait',
    });
    expect(decide(state, { [steps[0]]: 'slot' }, at(false))).not.toMatchObject({
      kind: 'remind',
    });
    expect(decide(state, { [steps[0]]: 'slot' }, at(true))).not.toMatchObject({
      reason: 'session seat: slot',
    });
  });
});
