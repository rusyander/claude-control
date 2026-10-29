import { describe, expect, it } from 'vitest';
import { openFresh } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import { seedSession, toolDeps } from './__fixtures__/seed.ts';
import { bindingOf } from './binding.ts';
import { handleModelTool } from './model-tools.ts';

/**
 * Вопрос человеку и помеха — только из идущего шага (ревью F-106): шаг уже ждёт ответа на
 * блокирующий вопрос — второй вопрос не пишет ещё одного `human.asked` при застывшем шаге.
 */

const MERGE = {
  question: 'merge the MR?',
  options: ['merge', 'wait'],
  recommendation: 'wait',
  blocking: true,
  action: { kind: 'merge', target: '!12' },
};

describe('model tools: step state', () => {
  it('F-106 ask_human and blocker on a step that is not running are refused without a human.asked', async () => {
    const { task } = await openFresh();
    const seeded = seedSession(task, { stepKind: 'work' });
    const bound = bindingOf(task, seeded.sessionId);
    if (!('binding' in bound)) throw new Error(bound.reason);
    const b = bound.binding;
    expect(handleModelTool(task, b, 'ask_human', MERGE, toolDeps())).toMatchObject({
      ok: true,
      result: { humanPoint: true, blocking: true },
    });
    expect(task.state.steps[b.stepId]?.state).toBe('waiting-human');
    const asks = () =>
      readJournalLines(task.dir, task.taskId).lines.filter((l) => l.kind === 'human.asked');
    expect(asks()).toHaveLength(1);

    expect(handleModelTool(task, b, 'ask_human', MERGE, toolDeps())).toMatchObject({
      ok: false,
      code: 'step-not-running',
    });
    expect(
      handleModelTool(task, b, 'blocker', { kind: 'access', detail: 'no token' }, toolDeps()),
    ).toMatchObject({ ok: false, code: 'step-not-running' });
    expect(asks()).toHaveLength(1);
    task.close();
  });
});
