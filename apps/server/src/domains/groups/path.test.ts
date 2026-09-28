import { describe, it, expect } from 'vitest';
import type { PathStep } from '@agentdeck/contracts/group-path';
import { buildPath, skillSteps, withinIndex } from './path.ts';
import { InvalidPathStepsError, normalizePathSteps } from './path-edit.ts';

const SKILL = ['## 1. Take the ticket', 'x', '## 2. Fix', 'y', '## 3. Deliver', 'z'].join('\n');

function step(id: string, over: Partial<PathStep> = {}): PathStep {
  return {
    id,
    anchor: 'work',
    order: 0,
    kind: 'prompt',
    title: { ru: id, en: id },
    prompt: { ru: id, en: id },
    source: 'ru',
    createdAt: '2026-09-26T10:00:00.000Z',
    ...over,
  };
}

const keys = (view: ReturnType<typeof buildPath>): string[] =>
  view.entries.map((entry) =>
    entry.kind === 'builtin'
      ? entry.stage
      : entry.kind === 'skill-step'
        ? `${entry.skillId}#${entry.index}`
        : `+${entry.step.id}`,
  );

describe('buildPath — steps inside a skill', () => {
  it('a step inside the skill stands right after the skill step it names', () => {
    const view = buildPath(
      {
        id: 'g',
        path: {
          steps: [
            step('first', { within: { skillId: 'td', index: -1, after: '' } }),
            step('mid', {
              order: 1,
              within: { skillId: 'td', index: 0, after: 'Take the ticket' },
            }),
            step('stage', { order: 2 }),
          ],
        },
      },
      [{ id: 'td', body: SKILL }],
    );
    expect(keys(view).slice(2, 9)).toEqual([
      'work',
      '+first',
      'td#0',
      '+mid',
      'td#1',
      'td#2',
      '+stage',
    ]);
  });

  it('a renamed skill step falls back to the number, a vanished one to the end', () => {
    expect(withinIndex({ skillId: 'td', index: 1, after: 'Gone' }, ['A', 'B', 'C'])).toBe(1);
    expect(withinIndex({ skillId: 'td', index: 9, after: 'Gone' }, ['A', 'B'])).toBe(1);
    expect(withinIndex({ skillId: 'td', index: 0, after: 'C' }, ['A', 'B', 'C'])).toBe(2);
  });

  it('a step inside a skill that is not in the view is still shown, at the end of the block', () => {
    const view = buildPath(
      {
        id: 'g',
        path: { steps: [step('orphan', { within: { skillId: 'x', index: 2, after: 'Q' } })] },
      },
      [],
    );
    expect(keys(view)).toContain('+orphan');
    expect(keys(view).indexOf('+orphan')).toBe(keys(view).indexOf('work') + 1);
  });
});

describe('buildPath — scenario', () => {
  it('a scenario is its steps only, in order, without stages or skill steps', () => {
    const view = buildPath(
      {
        id: 'g',
        flow: 'scenario',
        path: { steps: [step('b', { order: 1 }), step('a', { order: 0 })] },
      },
      [{ id: 'td', body: SKILL }],
    );
    expect(keys(view)).toEqual(['+a', '+b']);
  });
});

describe('normalizePathSteps — within', () => {
  it('a step inside a skill must belong to work', () => {
    const bad = step('x', { anchor: 'review', within: { skillId: 'td', index: 0, after: 'A' } });
    expect(() => normalizePathSteps({ steps: [bad] })).toThrow(InvalidPathStepsError);
    const good = step('x', { within: { skillId: 'td', index: 0, after: 'A' } });
    expect(normalizePathSteps({ steps: [good] })[0]?.within).toEqual(good.within);
  });
});

describe('skillSteps — ревью 28.09', () => {
  // F-257: номер сравнивался с предыдущим СЫРЫМ заголовком, а не с последним
  // принятым — подпункты «### 1. / ### 2.» после «## 3.» проходили как шаг 4.
  it('подпункты с новой нумерацией после шагов не становятся шагами', () => {
    const body = ['## 1. A', '## 2. B', '## 3. C', '### 1. c-one', '### 2. c-two'].join('\n');
    expect(skillSteps(body)).toEqual(['A', 'B', 'C']);
  });

  // F-258: любой забор переключал «внутри кода» — «~~~» внутри блока «```»
  // закрывал его, и пример заголовка из кода становился шагом.
  it('забор закрывается только тем же знаком, что открыл', () => {
    const body = ['## 1. A', '```md', '~~~', '## 2. fake', '```', '## 2. B'].join('\n');
    expect(skillSteps(body)).toEqual(['A', 'B']);
  });
});
