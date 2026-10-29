import { describe, expect, it } from 'vitest';
import type { StepDoneCall } from '@agentdeck/contracts/core/model-tools';
import { openFresh } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import { seedSession, toolDeps } from './__fixtures__/seed.ts';
import { bindingOf } from './binding.ts';
import { handleModelTool } from './model-tools.ts';
import type { SessionBinding } from './model-tools.types.ts';

/**
 * Доказательство `step_done` привязано к задаче и к прогону ядра (02:61, P92): зелёная запись
 * чужой задачи, захваченная сеансом или по производному argv `captured:` требование не покрывает.
 */

async function stepOf() {
  const fresh = await openFresh();
  const seeded = seedSession(fresh.task, { stepKind: 'work' });
  const bound = bindingOf(fresh.task, seeded.sessionId);
  if (!('binding' in bound)) throw new Error(bound.reason);
  return { ...fresh, b: bound.binding };
}

function claim(b: SessionBinding): StepDoneCall {
  return {
    stepId: b.stepId,
    outcome: 'done',
    requirements: [{ id: 'R1', state: 'covered', evidence: ['rec-green'] }],
    summary: 'did the work',
  };
}

const OTHER_TASK = '0192f000-0000-7000-8000-0000000000ff';

describe('step_done evidence binding', () => {
  it('a green record of another task, a session-captured one or a derived captured: check is rejected by name', async () => {
    const cases = [
      [{ verdict: 'pass', checkId: 'tests', taskId: OTHER_TASK, origin: 'core' }, /foreign task/],
      [{ verdict: 'pass', checkId: 'tests', taskId: null, origin: 'core' }, /foreign task/],
      [{ verdict: 'pass', checkId: 'tests', taskId: 'SELF', origin: 'session' }, /not a core run/],
      [
        { verdict: 'pass', checkId: 'captured:2f7b30c6', taskId: 'SELF', origin: 'core' },
        /not a registry check/,
      ],
    ] as const;
    for (const [facts, problem] of cases) {
      const { task, b } = await stepOf();
      const record = { ...facts, taskId: facts.taskId === 'SELF' ? task.taskId : facts.taskId };
      const reply = handleModelTool(
        task,
        b,
        'step_done',
        claim(b),
        toolDeps({ 'rec-green': record }),
      );
      expect(reply, JSON.stringify(facts)).toMatchObject({
        ok: false,
        code: 'evidence-rejected',
        issues: [{ message: expect.stringMatching(problem) }],
      });
      expect(
        readJournalLines(task.dir, task.taskId).lines.some((l) => l.kind === 'step.claimed'),
      ).toBe(false);
      task.close();
    }
    const { task, b } = await stepOf();
    const own = toolDeps({ 'rec-green': 'pass' });
    expect(handleModelTool(task, b, 'step_done', claim(b), own)).toMatchObject({ ok: true });
    task.close();
  });
});
