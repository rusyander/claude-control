import { describe, it, expect } from 'vitest';
import type { PathStep } from '@agentdeck/contracts/group-path';
import type { ChatLink } from '../../lib/app-store/app-store.types.ts';
import {
  chatPathHint,
  chatPathSteps,
  pathStepPrompt,
  planPathTurn,
  scanGateBlock,
  scenarioLine,
  skillInsertsLine,
} from './path-steps.ts';

const LINK: ChatLink = {
  parentChatId: 'root',
  createdAt: '2026-09-26T10:00:00.000Z',
  stage: 'work',
};

function step(id: string, over: Partial<PathStep> = {}): PathStep {
  return {
    id,
    anchor: 'work',
    order: 0,
    kind: 'prompt',
    title: { ru: `Шаг ${id}`, en: `Step ${id}` },
    prompt: { ru: `Сделай ${id}`, en: `Do ${id}` },
    source: 'ru',
    createdAt: '2026-09-26T10:00:00.000Z',
    ...over,
  };
}

const GATED = step('a', { gate: { ru: 'тесты зелёные', en: 'tests are green' } });
const gateBlock = (passed: boolean, note = 'checked'): string =>
  `Done.\n\n\`\`\`agentdeck:gate\n${JSON.stringify({ passed, note })}\n\`\`\``;

const turn = (over: Partial<Parameters<typeof planPathTurn>[0]>) =>
  planPathTurn({
    link: LINK,
    stage: 'work',
    steps: [GATED, step('b')],
    ok: true,
    paused: false,
    text: 'stage answer',
    task: 'stage task',
    ...over,
  });

describe('planPathTurn', () => {
  it('after the stage starts the first step and holds the stage answer', () => {
    const decision = turn({});
    expect(decision.kind).toBe('step');
    if (decision.kind !== 'step') return;
    expect(decision.step.id).toBe('a');
    expect(decision.link.pathRun).toEqual({
      done: ['a'],
      pending: 'a',
      held: { text: 'stage answer', task: 'stage task' },
    });
  });

  it('a passed gate moves to the next step and keeps the held stage answer', () => {
    const decision = turn({
      link: { ...LINK, pathRun: { done: ['a'], pending: 'a', held: { text: 'S', task: 'T' } } },
      text: gateBlock(true),
      task: 'step prompt',
    });
    expect(decision.kind).toBe('step');
    if (decision.kind !== 'step') return;
    expect(decision.step.id).toBe('b');
    expect(decision.link.pathRun?.held).toEqual({ text: 'S', task: 'T' });
  });

  it('a failed gate stops the chain with the note', () => {
    const decision = turn({
      link: { ...LINK, pathRun: { done: ['a'], pending: 'a', held: { text: 'S', task: 'T' } } },
      text: gateBlock(false, 'two tests red'),
    });
    expect(decision).toEqual({ kind: 'gate-failed', step: GATED, note: 'two tests red' });
  });

  it('a gated step without a gate block counts as failed, not passed', () => {
    const decision = turn({
      link: { ...LINK, pathRun: { done: ['a'], pending: 'a', held: { text: 'S', task: 'T' } } },
      text: 'I did it, trust me.',
    });
    expect(decision.kind).toBe('gate-failed');
  });

  it('a step turn that paused or failed waits, starting nothing', () => {
    const pending: ChatLink = { ...LINK, pathRun: { done: ['a'], pending: 'a' } };
    expect(turn({ link: pending, paused: true }).kind).toBe('wait');
    expect(turn({ link: pending, ok: false }).kind).toBe('wait');
  });

  it('after the last step the conveyor continues with the HELD stage answer', () => {
    const decision = turn({
      link: {
        ...LINK,
        pathRun: { done: ['a', 'b'], pending: 'b', held: { text: 'review block', task: 'T' } },
      },
      text: 'step b answer',
      task: 'step b prompt',
    });
    expect(decision).toEqual({
      kind: 'continue',
      text: 'review block',
      task: 'T',
      link: { ...LINK, pathRun: { done: ['a', 'b'] } },
    });
  });

  it('a step already run in this chat is not started again on a later human turn', () => {
    const decision = turn({ link: { ...LINK, pathRun: { done: ['a', 'b'] } }, text: 'human turn' });
    expect(decision).toMatchObject({ kind: 'continue', text: 'human turn' });
  });

  it('a stage that paused gets no steps yet', () => {
    expect(turn({ paused: true })).toEqual({
      kind: 'continue',
      text: 'stage answer',
      task: 'stage task',
    });
  });
});

describe('scanGateBlock', () => {
  it('reads the last closed block', () => {
    expect(scanGateBlock(`${gateBlock(false)}\n${gateBlock(true, 'ok')}`)).toEqual({
      passed: true,
      note: 'ok',
    });
  });

  it('a block without a boolean passed is no verdict', () => {
    expect(scanGateBlock('```agentdeck:gate\n{"passed":"yes"}\n```')).toBeUndefined();
  });
});

describe('pathStepPrompt', () => {
  it('uses the English side and asks for the gate block', () => {
    const prompt = pathStepPrompt(GATED, 'work');
    expect(prompt).toContain('after the work stage: Step a');
    expect(prompt).toContain('Do a');
    expect(prompt).not.toContain('Сделай a');
    expect(prompt).toContain('This step is closed only when: tests are green');
    expect(prompt).toContain('agentdeck:gate');
  });

  it('falls back to the Russian side when English is empty', () => {
    const prompt = pathStepPrompt(step('c', { prompt: { ru: 'Сделай c', en: ' ' } }), 'plan');
    expect(prompt).toContain('Сделай c');
    expect(prompt).not.toContain('agentdeck:gate');
  });

  it('a resource step names the skill to apply', () => {
    const prompt = pathStepPrompt(
      step('d', { kind: 'resource', resource: { type: 'skill', id: 'lint-all' } }),
      'fix',
    );
    expect(prompt).toContain('Apply the skill `lint-all`');
  });

  it('язык ответа — по строке человека из задания стадии, а не по английскому шагу', () => {
    const task = [
      'Work stage. Follow the plan below and report.',
      'Tasks of this group:',
      '- Поправить вёрстку карточки заказа на узком экране',
      '- Коротко',
    ].join('\n');
    const decision = turn({ task });
    expect(decision.kind).toBe('step');
    const prompt = decision.kind === 'step' ? decision.prompt : '';
    expect(prompt).toContain(
      'The human wrote, for example: "- Поправить вёрстку карточки заказа на узком экране"',
    );
    expect(prompt).not.toContain('Write your answer in the language of the task text');
    // Человек пишет по-английски — строки с чужими буквами нет, общая строка остаётся.
    expect(pathStepPrompt(GATED, 'work', 'Fix the order card on narrow screens.')).toContain(
      'Write your answer in the language of the task text',
    );
  });
});

describe('chatPathSteps', () => {
  const groups = [
    {
      id: 'g1',
      path: {
        steps: [
          step('late', { order: 2 }),
          step('early', { order: 1 }),
          step('other', { anchor: 'review' }),
        ],
      },
    },
    { id: 'g2', scope: { kind: 'project' as const, path: 'C:/p', provider: 'claude' } },
  ];

  it('returns the chosen group steps anchored at the stage, in path order', () => {
    expect(chatPathSteps(groups, 'global:g1', 'work').map((item) => item.id)).toEqual([
      'early',
      'late',
    ]);
  });

  it('auto and an unknown key give no steps', () => {
    expect(chatPathSteps(groups, 'auto', 'work')).toEqual([]);
    expect(chatPathSteps(groups, 'project:g1', 'work')).toEqual([]);
  });
});

describe('chatPathHint', () => {
  const groups = [
    {
      id: 'g1',
      name: 'Tests first',
      path: {
        steps: [
          step('s1', { anchor: 'fix', gate: { ru: 'зелёные', en: 'all green' } }),
          step('s0', { anchor: 'plan' }),
        ],
      },
    },
    { id: 'empty', name: 'Empty' },
  ];

  it('lists the chosen group steps in path order, English, with gates', () => {
    const hint = chatPathHint(groups, 'global:g1') ?? '';
    expect(hint).toContain('group "Tests first"');
    expect(hint.indexOf('After plan — Step s0')).toBeGreaterThan(-1);
    expect(hint.indexOf('After plan')).toBeLessThan(hint.indexOf('After fix — Step s1: Do s1'));
    expect(hint).toContain('Closed when: all green.');
    expect(hint).not.toContain('Сделай');
  });

  it('no group, auto or a group without steps gives no hint', () => {
    expect(chatPathHint(groups, 'auto')).toBeUndefined();
    expect(chatPathHint(groups, 'global:empty')).toBeUndefined();
    expect(chatPathHint(groups, 'global:none')).toBeUndefined();
  });
});

describe('steps inside a skill and scenarios', () => {
  const inner = step('in', {
    within: { skillId: 'td', index: 3, after: 'BEFORE shots' },
    gate: { ru: 'скрин есть', en: 'the shot exists' },
  });
  const groups = [
    { id: 'g1', name: 'Delivery', path: { steps: [inner, step('stage')] } },
    {
      id: 's1',
      name: 'Jira flow',
      flow: 'scenario' as const,
      path: { steps: [step('branch', { order: 1 }), step('read', { order: 0 })] },
    },
  ];

  it('a step inside a skill is never a turn after the stage, and not in the stage hint', () => {
    expect(chatPathSteps(groups, 'global:g1', 'work').map((item) => item.id)).toEqual(['stage']);
    expect(chatPathHint(groups, 'global:g1')).not.toContain('Do in');
  });

  it('the inserts line names the skill, the step it follows, and the gate', () => {
    const line = skillInsertsLine(groups[0]!) ?? '';
    expect(line).toContain('Skill `td`, right after its step "BEFORE shots" — Step in: Do in');
    expect(line).toContain('Closed when: the shot exists.');
    expect(skillInsertsLine({ name: 'x', path: { steps: [step('stage')] } })).toBeUndefined();
  });

  it('a scenario runs as one ordered line, never as stage turns or a stage hint', () => {
    expect(chatPathSteps(groups, 'global:s1', 'work')).toEqual([]);
    expect(chatPathHint(groups, 'global:s1')).toBeUndefined();
    const line = scenarioLine(groups[1]!) ?? '';
    expect(line).toContain('scenario "Jira flow"');
    expect(line.indexOf('1. Step read: Do read')).toBeGreaterThan(-1);
    expect(line.indexOf('1. Step read')).toBeLessThan(line.indexOf('2. Step branch'));
    expect(scenarioLine(groups[0]!)).toBeUndefined();
  });
});

describe('resource steps', () => {
  it('a utility step tells the model to RUN the script, not just follow it', () => {
    const prompt = pathStepPrompt(
      step('u', { kind: 'resource', resource: { type: 'script', id: 'lint-all.mjs' } }),
      'work',
    );
    expect(prompt).toContain('Run the utility script `lint-all.mjs`');
  });
});
