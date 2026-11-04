import { describe, it, expect } from 'vitest';
import type { PathStep } from '@agentdeck/contracts/group-path';
import { chatPathSteps, scenarioLine, skillInsertsLine } from './path-steps.ts';

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

  it('a step inside a skill is never a step after the stage', () => {
    expect(chatPathSteps(groups, 'global:g1', 'work').map((item) => item.id)).toEqual(['stage']);
  });

  it('the inserts line names the skill, the step it follows, and the gate', () => {
    const line = skillInsertsLine(groups[0]!) ?? '';
    expect(line).toContain('Skill `td`, right after its step "BEFORE shots" — Step in: Do in');
    expect(line).toContain('Closed when: the shot exists.');
    expect(skillInsertsLine({ name: 'x', path: { steps: [step('stage')] } })).toBeUndefined();
  });

  it('a scenario runs as one ordered line, never as steps after a stage', () => {
    expect(chatPathSteps(groups, 'global:s1', 'work')).toEqual([]);
    const line = scenarioLine(groups[1]!) ?? '';
    expect(line).toContain('scenario "Jira flow"');
    expect(line.indexOf('1. Step read: Do read')).toBeGreaterThan(-1);
    expect(line.indexOf('1. Step read')).toBeLessThan(line.indexOf('2. Step branch'));
    expect(scenarioLine(groups[0]!)).toBeUndefined();
  });
});

describe('resource steps', () => {
  const scenario = (resource: PathStep['resource']) =>
    scenarioLine({
      name: 'Tools',
      flow: 'scenario',
      path: { steps: [step('r', { kind: 'resource', resource, prompt: { ru: '', en: '' } })] },
    }) ?? '';

  it('a utility step tells the model to RUN the script, not just follow it', () => {
    expect(scenario({ type: 'script', id: 'lint-all.mjs' })).toContain(
      'Run the utility script `lint-all.mjs`',
    );
  });

  it('a skill step names the skill to apply, another resource is followed', () => {
    expect(scenario({ type: 'skill', id: 'lint-all' })).toContain('Apply the skill `lint-all`');
    expect(scenario({ type: 'rule', id: 'no-any' } as PathStep['resource'])).toContain(
      'The rule `no-any` is active for this step; follow it.',
    );
  });

  it('an English side left empty falls back to the Russian one', () => {
    const line =
      scenarioLine({
        name: 'Ru',
        flow: 'scenario',
        path: { steps: [step('c', { prompt: { ru: 'Сделай c', en: ' ' } })] },
      }) ?? '';
    expect(line).toContain('Сделай c');
  });
});
