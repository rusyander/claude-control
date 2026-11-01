import { describe, expect, it } from 'vitest';
import { openFresh } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { seedSession, SEED_HUMAN_POLICY } from '../model-tools/__fixtures__/seed.ts';
import type { RaiseInput } from './human.types.ts';
import { raiseHumanPoint } from './raise.ts';

/**
 * Один подъём вопроса (G15, P20, P130): пункт решает только закрытый список — источник ядра
 * называет лишь свои пункты, вопрос модели без действия списка — развилка в отчёт; ключ `dedupe`
 * у открытого вопроса второго вопроса не даёт, закрытый вопрос ключ освобождает.
 */

const policy = { policy: SEED_HUMAN_POLICY };

function asked(task: LiveTask) {
  return readJournalLines(task.dir, task.taskId).lines.filter((l) => l.kind === 'human.asked');
}

function raise(stepId: string | null, over: Partial<RaiseInput>): RaiseInput {
  return {
    source: 'round-cap',
    stepId,
    sessionId: null,
    action: null,
    point: 6,
    dedupe: null,
    question: 'q',
    options: ['one more round', 'stop'],
    recommendation: 'stop',
    blocking: true,
    ...over,
  };
}

describe('conductor/human raiseHumanPoint', () => {
  it('P20 a core source names only its own item; a wrong item or a model-named item raises nothing', async () => {
    const { task } = await openFresh();
    const { stepId } = seedSession(task, { stepKind: 'work' });
    const cases: [Partial<RaiseInput>, string][] = [
      [{ source: 'round-cap', point: 6 }, 'asked'],
      [{ source: 'budget', point: 7 }, 'asked'],
      [{ source: 'scenario-step', point: 8 }, 'asked'],
      [{ source: 'launch', point: 10 }, 'asked'],
      [{ source: 'reconcile', point: 4 }, 'asked'],
      [{ source: 'permit', point: 3 }, 'asked'],
      [{ source: 'permit', point: 5 }, 'asked'],
      [{ source: 'round-cap', point: 7 }, 'refused'],
      [{ source: 'launch', point: null }, 'refused'],
      [{ source: 'permit', point: 4 }, 'refused'],
      [{ source: 'ask_human', point: 6 }, 'refused'],
      [{ source: 'ask_human', point: null, blocking: true }, 'fork'],
      [{ source: 'blocker', point: null, action: { kind: 'merge', target: 'x' } }, 'asked'],
    ];
    for (const [over, kind] of cases) {
      const out = raiseHumanPoint(task, raise(null, over), policy);
      expect(out.kind, JSON.stringify(over)).toBe(kind);
    }
    expect(asked(task)).toHaveLength(cases.filter(([, k]) => k === 'asked').length);
    // Шаг ждёт только блокирующего вопроса со ссылкой на шаг.
    const waits = raiseHumanPoint(task, raise(stepId, {}), policy);
    expect(waits).toMatchObject({ kind: 'asked', waiting: true, point: 6 });
    expect(task.state.steps[stepId]?.state).toBe('waiting-human');
  });

  it('P20 an off-list blocking model ask turns into a fork with the recommendation, never a human.asked', async () => {
    const { task } = await openFresh();
    const { stepId } = seedSession(task, { stepKind: 'work' });
    const out = raiseHumanPoint(
      task,
      raise(stepId, { source: 'ask_human', point: null, recommendation: 'one more round' }),
      policy,
    );
    expect(out).toMatchObject({ kind: 'fork', proceedWith: 'one more round' });
    expect(asked(task)).toHaveLength(0);
    expect(task.state.steps[stepId]?.state).toBe('running');
  });

  it('P130 one open ask per dedupe key; a closed ask frees the key; a model raise needs the policy', async () => {
    const { task } = await openFresh();
    const { stepId } = seedSession(task, { stepKind: 'work' });
    const key = `permit:${stepId}:5:edit:migrations/1.sql`;
    const first = raiseHumanPoint(task, raise(stepId, { source: 'permit', point: 5, dedupe: key }));
    const again = raiseHumanPoint(task, raise(stepId, { source: 'permit', point: 5, dedupe: key }));
    expect(first.kind).toBe('asked');
    expect(again).toMatchObject({
      kind: 'duplicate',
      askId: first.kind === 'asked' ? first.askId : '',
    });
    expect(asked(task)).toHaveLength(1);
    if (first.kind !== 'asked') throw new Error('not asked');
    task.append({
      kind: 'ask.transition',
      actor: 'core',
      data: { askId: first.askId, event: 'answer', from: 'open', to: 'answered' },
    });
    const third = raiseHumanPoint(task, raise(stepId, { source: 'permit', point: 5, dedupe: key }));
    expect(third.kind).toBe('asked');
    expect(asked(task)).toHaveLength(2);
    expect(() =>
      raiseHumanPoint(task, raise(newId(), { source: 'ask_human', point: null })),
    ).toThrow(/needs the human policy/);
  });
});
