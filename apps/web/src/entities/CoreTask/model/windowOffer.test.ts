import { describe, expect, it } from 'vitest';
import type { TaskView } from '@agentdeck/contracts/core/task-view';
import { askHoldsOffers, offerCommand, offersOf } from '@agentdeck/contracts/core/window-offer';

const TASK = '01900000-0000-7000-8000-0000000c0001';
const STEP = '01900000-0000-7000-8000-0000000c0201';

function view(patch: Partial<TaskView> = {}, offers?: string[]): TaskView {
  return {
    asks: [],
    windowWait: {
      stepId: STEP,
      routeId: 'claude-login',
      verdict: 'refused',
      resetAt: null,
      alternatives: [],
      skipped: [],
      ...(offers ? { offers } : {}),
      seq: 3,
    },
    ...patch,
  } as TaskView;
}

describe('window offer → core command (P169, P184)', () => {
  it('reads cli:/model: offers and skips text of any other shape', () => {
    expect(offersOf(view({}, ['cli:codex', 'model:sonnet', 'wait', 'cli:']))).toEqual([
      { option: 'cli:codex', kind: 'cli', value: 'codex' },
      { option: 'model:sonnet', kind: 'model', value: 'sonnet' },
    ]);
    expect(offersOf(view())).toEqual([]);
  });

  it('cli offer → set-cli on the task now; model offer → set-model with effort null', () => {
    expect(offerCommand(TASK, { option: 'cli:codex', kind: 'cli', value: 'codex' })).toEqual({
      kind: 'set-cli',
      taskId: TASK,
      fields: { scope: 'task', scopeId: TASK, timing: 'now', adapter: 'codex' },
    });
    expect(offerCommand(TASK, { option: 'model:sonnet', kind: 'model', value: 'sonnet' })).toEqual({
      kind: 'set-model',
      taskId: TASK,
      fields: { scope: 'task', scopeId: TASK, timing: 'now', model: 'sonnet', effort: null },
    });
  });

  it('an open exhausted ask of the same step holds the offers; answered or other step does not', () => {
    const ask = (state: 'open' | 'answered', stepId: string) => ({
      askId: '01900000-0000-7000-8000-0000000c0401',
      state,
      point: 7,
      source: 'budget' as const,
      dedupe: `exhausted:claude-login:${stepId}`,
      stepId,
      lateAnswer: false,
      answer: null,
    });
    expect(askHoldsOffers(view({ asks: [ask('open', STEP)] }))).toBe(true);
    expect(askHoldsOffers(view({ asks: [ask('answered', STEP)] }))).toBe(false);
    expect(
      askHoldsOffers(view({ asks: [ask('open', '01900000-0000-7000-8000-0000000c0299')] })),
    ).toBe(false);
  });
});
