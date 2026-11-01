import { SESSION_STATE_V } from '@agentdeck/contracts/core/user-layer';
import type { StepDef } from '@agentdeck/contracts/core/scenario';
import { afterEach, describe, expect, it } from 'vitest';
import { createTaskRegistry, type TaskRegistry } from '../tasks.ts';
import { CREATED, deps, tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { seedRequirements, seedSession } from '../model-tools/__fixtures__/seed.ts';
import { presetStep } from '../scenario/presets.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { sessionStateDoc } from './state-doc.ts';

/**
 * 03:81-82, G8 — документ `agentdeck state` собирается из свёртки задачи одним путём: шаг,
 * требования с вердиктами по порядку, свои пути единицы, обязательные проверки, бюджеты (токены и
 * минуты рабочего времени), ожидание CI, режим слоя шага. Не собранное — `unknown`, не пустое.
 */

let registry: TaskRegistry | undefined;
afterEach(() => {
  registry?.closeAll();
  registry = undefined;
});

const OWNED_UNIT = newId();
const WORK: StepDef = {
  ...presetStep('work', 'work', 'Работа', []),
  checks: { mid: 'narrow', required: ['unit', 'lint'] },
  budget: { tokens: 50_000 },
  userLayer: { hooks: 'observe', skills: 'off' },
};

async function liveTask(ciWait = true) {
  registry = createTaskRegistry(tempDir('state-doc-'), deps());
  const task = await registry.create({ ...CREATED, ciWait });
  return task;
}

describe('03:82 session state document (conductor/state-doc)', () => {
  it('the doc names the step, requirements in ordinal order with verdicts, owned paths, required checks, budgets, ciWait and the step layer', async () => {
    const task = await liveTask(true);
    seedRequirements(task);
    const s = seedSession(task, { stepKind: 'work' });
    task.append({
      kind: 'unit.created',
      actor: 'core',
      unitId: OWNED_UNIT,
      data: {
        unitId: OWNED_UNIT,
        repoKey: 'r1',
        branch: 'agentdeck/owned',
        ownedPaths: ['src/a.ts', 'src/b/**'],
        name: 'unit',
        after: [],
        contract: false,
        splitId: null,
      },
    });
    const owned = seedSession(task, { stepKind: 'work', unitId: OWNED_UNIT });
    const got = sessionStateDoc({
      state: task.state,
      stepId: owned.stepId,
      def: WORK,
      source: 'core',
    });
    if (!('value' in got)) throw new Error(got.unknown);
    expect(got.value).toEqual({
      v: SESSION_STATE_V,
      source: 'core',
      asOf: task.state.seq,
      task: task.taskId,
      step: { id: owned.stepId, kind: 'work', title: 'Работа', defId: 'work' },
      requirements: Object.entries(task.state.requirements)
        .sort(([, a], [, b]) => a.ordinal - b.ordinal)
        .map(([id, r]) => ({ id, text: r.text, verdict: 'open' })),
      ownedPaths: ['src/a.ts', 'src/b/**'],
      requiredChecks: ['unit', 'lint'],
      budgets: { tokens: { spent: 0, limit: 50_000 }, minutes: { spent: 0, limit: 10 } },
      ciWait: true,
      layer: { hooks: 'observe', skills: 'off' },
    });
    expect(got.value.requirements.map((r) => r.text)).toEqual(['requirement 1', 'requirement 2']);
    // Другой шаг другой единицы — свои пути (здесь — никаких), а не пути соседа.
    const other = sessionStateDoc({
      state: task.state,
      stepId: s.stepId,
      def: WORK,
      source: 'core',
    });
    expect('value' in other && other.value.ownedPaths).toEqual([]);
  });

  it('a human budget extension wins over the scenario token limit; snapshot source is carried as given', async () => {
    const task = await liveTask(false);
    const s = seedSession(task, { stepKind: 'work' });
    task.append({
      kind: 'budget.state',
      actor: 'core',
      stepId: s.stepId,
      data: { scope: `tokens:step:${s.stepId}`, spent: 10, limit: 90_000 },
    });
    const got = sessionStateDoc({
      state: task.state,
      stepId: s.stepId,
      def: WORK,
      source: 'snapshot',
    });
    if (!('value' in got)) throw new Error(got.unknown);
    expect(got.value.budgets.tokens.limit).toBe(90_000);
    expect(got.value.source).toBe('snapshot');
    expect(got.value.ciWait).toBe(false);
  });

  it('an unknown step, a missing definition or a definition of another step is unknown with a reason, never an empty doc', async () => {
    const task = await liveTask();
    const s = seedSession(task, { stepKind: 'work' });
    expect(
      sessionStateDoc({ state: task.state, stepId: 'nope', def: WORK, source: 'core' }),
    ).toEqual({
      unknown: 'step nope not in the task journal',
    });
    expect(
      sessionStateDoc({ state: task.state, stepId: s.stepId, def: null, source: 'core' }),
    ).toEqual({
      unknown: 'step definition work not found in the task scenario',
    });
    const review = presetStep('review', 'review', 'Ревью', []);
    expect(
      sessionStateDoc({ state: task.state, stepId: s.stepId, def: review, source: 'core' }),
    ).toMatchObject({ unknown: expect.stringContaining('review is not work') });
  });
});
