import { describe, expect, it } from 'vitest';
import type { StepDef } from '@agentdeck/contracts/core/scenario';
import type { UserLayerInventory } from '@agentdeck/contracts/core/user-layer';
import type { StepCtx } from '../../conductor/run/run.types.ts';
import { presetStep } from '../../conductor/scenario/index.ts';
import type { TaskFoldState } from '../../journal/reduce/reduce.types.ts';
import { scenarioHooks, type ScenarioWiringDeps } from './scenario.ts';

/**
 * Уровень 5 = только порядок шагов навыка (G4): опись слоя даёт `flow` навыков шага, бриф шага
 * раскладывает их подшагами; место подшага из «Пути» привязывается к шагу навыка по заголовку,
 * затем по номеру. Нет порта или описи — остаётся текст «Пути»; опись не прочлась — причина названа.
 */

const FLOW = {
  steps: [
    { id: 'read', title: 'Read the ticket' },
    { id: 'plan', title: 'Write the plan' },
    { id: 'code', title: 'Write the code' },
  ],
};

function inventory(flow: typeof FLOW | null): UserLayerInventory {
  return {
    cli: 'claude',
    hash: 'h',
    sources: [],
    hooks: [],
    skills: [{ name: 'ticket-flow', path: '/l/skills/ticket-flow/SKILL.md', flow, extraKeys: [] }],
    agents: [],
    unread: [],
  };
}

const STATE = { created: { title: 'Задача' }, scenario: null } as unknown as TaskFoldState;

function ctx(def: StepDef): StepCtx {
  return {
    taskId: 't1',
    unitId: 'u1',
    repoKey: 'r1',
    copyDir: null,
    stepId: 's1',
    def,
    round: 0,
    sessionId: null,
  };
}

function hooks(port?: ScenarioWiringDeps['userLayerInventory']) {
  const deps = { registry: { view: () => STATE }, userLayerInventory: port };
  return scenarioHooks(deps as unknown as ScenarioWiringDeps);
}

async function knowledge(def: StepDef, port?: ScenarioWiringDeps['userLayerInventory']) {
  const got = await hooks(port).preStep?.(ctx(def));
  return got?.sections.find((s) => s.id === 'knowledge')?.text;
}

const withSkill = presetStep('work', 'work', 'Работа', [], {});
withSkill.knowledge.skills = ['ticket-flow'];
const within = (w: NonNullable<StepDef['within']>): StepDef => ({
  ...presetStep('extra', 'work', 'Доп. шаг', []),
  within: w,
});

describe('level 5 = skill flow only (G4): flow → within sub-steps in the brief', () => {
  it('a step skill with a flow lists its sub-steps in order', async () => {
    expect(await knowledge(withSkill, () => inventory(FLOW))).toBe(
      [
        'skill ticket-flow',
        'skill ticket-flow steps, in order:',
        '  1. Read the ticket (read)',
        '  2. Write the plan (plan)',
        '  3. Write the code (code)',
      ].join('\n'),
    );
  });

  it('a Path within anchors on the flow step title first, then on the index', async () => {
    const port = () => inventory(FLOW);
    const byTitle = await knowledge(
      within({ skillId: 'ticket-flow', index: 0, after: 'Write the plan' }),
      port,
    );
    expect(byTitle?.split('\n').at(-1)).toBe(
      'this sub-step goes right after step 2 "Write the plan" of skill ticket-flow',
    );
    const byIndex = await knowledge(
      within({ skillId: 'ticket-flow', index: 2, after: 'Renamed title' }),
      port,
    );
    expect(byIndex?.split('\n').at(-1)).toBe(
      'this sub-step goes right after step 3 "Write the code" of skill ticket-flow',
    );
    const first = await knowledge(within({ skillId: 'ticket-flow', index: -1, after: '' }), port);
    expect(first?.split('\n').at(-1)).toBe('this sub-step goes before step 1 of skill ticket-flow');
    const lost = await knowledge(within({ skillId: 'ticket-flow', index: 7, after: 'Gone' }), port);
    expect(lost?.split('\n').at(-1)).toBe(
      `this is sub-step 7 of skill ticket-flow, after "Gone" (not found in the skill's steps: place it by the text)`,
    );
  });

  it('no port, no flow in the inventory: the Path-only within stays as the fallback', async () => {
    const def = within({ skillId: 'ticket-flow', index: 1, after: 'Write the plan' });
    const pathOnly = 'this is sub-step 1 of skill ticket-flow, after "Write the plan"';
    expect(await knowledge(def)).toBe(pathOnly);
    expect(await knowledge(def, () => inventory(null))).toBe(pathOnly);
    expect(await knowledge(def, async () => null)).toBe(pathOnly);
  });

  it('an unreadable inventory does not stop the step: the brief names why the flow is unknown', async () => {
    const got = await hooks(() => {
      throw new Error('EACCES skills dir');
    }).preStep?.(ctx(withSkill));
    expect(got?.verdict).toEqual({ ok: true });
    expect(got?.sections.find((s) => s.id === 'knowledge')?.text).toBe(
      'skill ticket-flow\nskill steps unknown: user layer inventory unread (EACCES skills dir)',
    );
  });
});
