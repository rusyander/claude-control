import { describe, expect, it } from 'vitest';
import type { JournalKind, JournalLine } from '@agentdeck/contracts/core/journal';
import type { StepDef } from '@agentdeck/contracts/core/scenario';
import { initialState, reduce } from '../../journal/reduce/reduce.ts';
import type { TaskFoldState } from '../../journal/reduce/reduce.types.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { unitView } from '../next/attempts.ts';
import { leadGate } from '../next/lead-gate.ts';
import { publishStep } from '../next/publish.ts';
import { presetOf } from '../scenario/presets.ts';
import { INTEGRATION_ROLE, INTEGRATION_STEP_IDS, integratedGate } from './integrated.ts';

/**
 * Ворота `integrated` у судьи `next` (этап 11, W3-18b) на свёртке настоящих строк журнала:
 * единица деления с интеграцией не публикуется, пока интеграция не зелёная; красная интеграция
 * закрывает единицы с причиной — ни одна не публикуется; зелёная — публикация по рёбрам. Шаги
 * интеграции идут только в её единице, её единица — только ими.
 */

const TASK = newId();
const LEAD = presetOf({ id: 'lead', version: 1 })!;
const def = (id: string): StepDef => LEAD.steps.find((s) => s.id === id)!;
const PUBLISH = def('publish');

type Add = (kind: JournalKind, data: unknown) => void;

function fold(build: (add: Add) => void): TaskFoldState {
  let state = initialState(TASK);
  let seq = 0;
  build((kind, data) => {
    seq += 1;
    const line = {
      v: 1,
      seq,
      at: seq,
      mono: seq,
      bootId: TASK,
      taskId: TASK,
      kind,
      actor: 'core',
      data,
    };
    state = reduce(state, line as JournalLine);
  });
  return state;
}

const created = {
  title: 't',
  repos: [],
  build: 'b',
  scenario: { id: 'lead', version: 1 },
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

const A = newId();
const B = newId();
const I = newId();
const SPLIT = newId();

const unitLine = (unitId: string, after: string[], role?: string) => ({
  unitId,
  name: role ? 'integration' : `u-${unitId.slice(-4)}`,
  repoKey: 'r1',
  branch: `agentdeck/${unitId.slice(-8)}`,
  ownedPaths: role ? [] : [`src/${unitId.slice(-4)}.ts`],
  after,
  contract: false,
  splitId: SPLIT,
  ...(role ? { role } : {}),
});

const move = (add: Add, unitId: string, event: string, from: string, to: string) =>
  add('unit.transition', { unitId, event, from, to });

/**
 * A и B параллельны, B после A по публикации (`after` — как задаёт ребро плана), I — интеграция
 * после обеих. A и B сдали всё до публикации; `integ` — куда дошла интеграция.
 */
function plan(integ: 'running' | 'closed' | 'ready', aTo?: 'published' | 'closed'): TaskFoldState {
  return fold((add) => {
    add('task.created', created);
    add('task.transition', { taskId: TASK, event: 'launch', from: 'draft', to: 'running' });
    add('unit.created', unitLine(A, []));
    add('unit.created', unitLine(B, [A]));
    add('unit.created', unitLine(I, [A, B], INTEGRATION_ROLE));
    for (const u of [A, B]) {
      move(add, u, 'start', 'planned', 'running');
      move(add, u, 'ready', 'running', 'ready-to-publish');
    }
    if (aTo) move(add, A, aTo === 'published' ? 'published' : 'close', 'ready-to-publish', aTo);
    if (integ === 'closed') {
      move(add, I, 'close', 'planned', 'closed');
      return;
    }
    move(add, I, 'start', 'planned', 'running');
    if (integ === 'ready') {
      gateStep(add, 'done');
      move(add, I, 'ready', 'running', 'ready-to-publish');
    }
  });
}

/** Шаг ворот интеграции единицы I: сдан зелёным или пропущен (сценарий без шагов интеграции). */
function gateStep(add: Add, end: 'done' | 'skipped'): void {
  const stepId = newId();
  add('step.started', {
    stepId,
    unitId: I,
    stepKind: 'final-gate',
    stepDefId: INTEGRATION_STEP_IDS[0],
    round: 0,
    budgetMs: 1000,
  });
  const to = (event: string, from: string, next: string) =>
    add('step.transition', { stepId, event, from, to: next });
  if (end === 'skipped') return to('skip', 'queued', 'skipped');
  to('start', 'queued', 'running');
  to('check', 'running', 'checking');
  to('checked-green', 'checking', 'done');
}

const publishOf = (state: TaskFoldState, unitId: string) =>
  publishStep(
    { state, scenario: LEAD, workNowMs: 0, live: {} },
    LEAD,
    unitView(state, unitId),
    state.units[unitId]!,
    PUBLISH,
  );

describe('W3-18b integrated gate at next: publish waits for a green integration', () => {
  it('integration still running → every split unit waits, the reason names the integration unit', () => {
    const state = plan('running');
    const got = publishOf(state, A);
    expect(got).toMatchObject({ kind: 'wait' });
    expect(got && 'reason' in got ? got.reason : '').toContain(`integration ${I}`);
  });

  it('integration closed (red) → A closes naming the red integration, then B closes behind it; none starts publish', () => {
    const state = plan('closed');
    const a = publishOf(state, A);
    expect(a).toMatchObject({ kind: 'end-unit', unitId: A, event: 'close' });
    expect(a && 'reason' in a ? a.reason : '').toContain(`integration ${I} red`);
    expect(integratedGate(state, B)).toMatchObject({ kind: 'red' });
    // B стоит за A по рёбрам публикации: ждёт его, а закрытый A закрывает и B.
    expect(publishOf(state, B)).toMatchObject({ kind: 'wait' });
    const b = publishOf(plan('closed', 'closed'), B);
    expect(b).toMatchObject({ kind: 'end-unit', unitId: B, event: 'close' });
  });

  it('integration closed (red), no publish edge → the parallel unit closes naming the integration too', () => {
    const state = fold((add) => {
      add('task.created', created);
      add('unit.created', unitLine(A, []));
      add('unit.created', unitLine(B, []));
      add('unit.created', unitLine(I, [A, B], INTEGRATION_ROLE));
      for (const u of [A, B]) {
        move(add, u, 'start', 'planned', 'running');
        move(add, u, 'ready', 'running', 'ready-to-publish');
      }
      move(add, I, 'close', 'planned', 'closed');
    });
    for (const u of [A, B]) {
      const got = publishOf(state, u);
      expect(got).toMatchObject({ kind: 'end-unit', unitId: u, event: 'close' });
      expect(got && 'reason' in got ? got.reason : '').toContain(`integration ${I} red`);
    }
  });

  it('integration green → publish in dependency order: A starts, B waits for A; once A is published, B starts', () => {
    const state = plan('ready');
    expect(publishOf(state, A)).toMatchObject({
      kind: 'start-step',
      unitId: A,
      stepDefId: 'publish',
    });
    expect(publishOf(state, B)).toMatchObject({ kind: 'wait' });
    const later = plan('ready', 'published');
    expect(publishOf(later, B)).toMatchObject({
      kind: 'start-step',
      unitId: B,
      stepDefId: 'publish',
    });
  });

  it('integration walked to ready with its gate skipped (a scenario edited without the integration steps) → red, no unit publishes on a vacuous green', () => {
    const state = fold((add) => {
      add('task.created', created);
      add('unit.created', unitLine(A, []));
      add('unit.created', unitLine(B, []));
      add('unit.created', unitLine(I, [A, B], INTEGRATION_ROLE));
      for (const u of [A, B]) {
        move(add, u, 'start', 'planned', 'running');
        move(add, u, 'ready', 'running', 'ready-to-publish');
      }
      move(add, I, 'start', 'planned', 'running');
      gateStep(add, 'skipped');
      move(add, I, 'ready', 'running', 'ready-to-publish');
    });
    for (const u of [A, B]) {
      const got = publishOf(state, u);
      expect(got).toMatchObject({ kind: 'end-unit', unitId: u, event: 'close' });
      expect(got && 'reason' in got ? got.reason : '').toContain('integration gate never passed');
    }
  });

  it('a unit with no integration publishes as before (gate silent)', () => {
    const state = fold((add) => {
      add('task.created', created);
      add('unit.created', unitLine(A, []));
      move(add, A, 'start', 'planned', 'running');
      move(add, A, 'ready', 'running', 'ready-to-publish');
    });
    expect(integratedGate(state, A)).toBeNull();
    expect(publishOf(state, A)).toMatchObject({ kind: 'start-step', stepDefId: 'publish' });
  });
});

describe('W3-18b integration steps by unit role', () => {
  const state = plan('running');
  for (const id of INTEGRATION_STEP_IDS)
    it(`a split unit skips ${id}; the integration unit runs it`, () => {
      expect(leadGate(state, def(id), A)).toMatchObject({ kind: 'skip-step', stepDefId: id });
      expect(leadGate(state, def(id), I)).toBeNull();
    });
  for (const id of ['work', 'review', 'fix', 'final-gate', 'publish'])
    it(`the integration unit skips ${id}`, () => {
      expect(leadGate(state, def(id), I)).toMatchObject({ kind: 'skip-step', stepDefId: id });
    });
});
