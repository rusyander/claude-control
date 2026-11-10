import { describe, expect, it } from 'vitest';
import type { BoardCard } from '@agentdeck/contracts/core/board';
import type { TaskView } from '@agentdeck/contracts/core/task-view';
import {
  agentsOf,
  estimateOfView,
  leadOf,
  mrOf,
  scenarioOf,
  spendOfView,
  unitsOfView,
} from './cardFacts';

const zeroUsage = { input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0, turns: 0 };
const zeroCost = { usd: 0, windowUnits: 0, unpricedTokens: 0, versions: {}, turns: 0 };

function view(extra: Partial<TaskView> = {}): TaskView {
  return {
    taskId: 't',
    seq: 1,
    state: 'running',
    ended: null,
    steps: [],
    sessions: [],
    checks: [],
    asks: [],
    budgets: [],
    windows: [],
    spend: { tokens: zeroUsage, cost: zeroCost, bySession: {}, byStep: {} },
    report: null,
    scenario: null,
    split: null,
    attention: null,
    ...extra,
  } as TaskView;
}

const card: BoardCard = {
  kind: 'task',
  id: 't',
  taskId: 't',
  column: 'work',
  title: 'T',
  stop: 'mr',
  waiting: false,
  questions: 0,
  takeover: null,
  moves: [],
  createdAt: 1,
};

const session = (state: string) => ({ state }) as TaskView['sessions'][number];

describe('card modal facts', () => {
  it('spend is absent (not 0) without a view or before any turn or token', () => {
    expect(spendOfView(undefined)).toBeNull();
    expect(spendOfView(view())).toBeNull();
    const spent = view({
      spend: {
        tokens: { ...zeroUsage, input: 100, output: 20, cacheRead: 5, turns: 2 },
        cost: zeroCost,
        bySession: {},
        byStep: {},
      },
    });
    expect(spendOfView(spent)).toEqual({ tokens: 125, turns: 2 });
  });

  it('agents: now = running sessions, total = every session; no view — absent', () => {
    expect(agentsOf(undefined)).toBeNull();
    const v = view({
      sessions: [session('live'), session('quiet'), session('ended'), session('lost')],
    });
    expect(agentsOf(v)).toEqual({ now: 2, total: 4 });
    expect(agentsOf(view())).toEqual({ now: 0, total: 0 });
  });

  it('the estimate sums unit token estimates of the split; none known — absent', () => {
    expect(estimateOfView(undefined)).toBeNull();
    const unit = (tokens: number | null) => ({ estimate: { minutes: null, tokens } });
    const split = (units: unknown[]) => ({ split: { units } }) as unknown as Partial<TaskView>;
    expect(estimateOfView(view(split([unit(null)])))).toBeNull();
    expect(estimateOfView(view(split([unit(1000), unit(null), unit(500)])))).toBe(1500);
  });

  it('unit progress shows the latest step of each unit in first-step order', () => {
    const step = (unitId: string, startedSeq: number, stepKind: string, state: string) =>
      ({ unitId, startedSeq, stepKind, state }) as TaskView['steps'][number];
    const v = view({
      steps: [
        step('u2', 3, 'review', 'running'),
        step('u1', 1, 'plan', 'done'),
        step('u1', 5, 'work', 'running'),
      ],
    });
    expect(unitsOfView(v)).toEqual([
      { n: 1, unitId: 'u1', step: 'work', state: 'running' },
      { n: 2, unitId: 'u2', step: 'review', state: 'running' },
    ]);
  });

  it('MR comes from the card first, then the last MR of the view; none — absent', () => {
    expect(mrOf(card, undefined)).toBeNull();
    const fromView = view({
      mrs: [{ unitId: 'u', url: 'https://forge.example.com/mr/3', iid: 3, state: 'opened' }],
    });
    expect(mrOf(card, fromView)?.iid).toBe(3);
    const withCard = { ...card, mr: { url: 'u', iid: 9, title: 'Fix', state: 'merged' as const } };
    expect(mrOf(withCard, fromView)).toEqual({ url: 'u', iid: 9, title: 'Fix', state: 'merged' });
  });

  it('scenario and lead fall back from the view to the card and to absent', () => {
    expect(scenarioOf(card, undefined)).toBeNull();
    expect(scenarioOf({ ...card, preset: 'bug-fix' }, undefined)).toBe('bug-fix');
    const v = view({ scenario: { ref: { id: 'feature', version: 2 }, pending: null } });
    expect(scenarioOf({ ...card, preset: 'bug-fix' }, v)).toBe('feature@2');
    expect(leadOf(card, undefined)).toBeNull();
    expect(leadOf({ ...card, lead: { profile: 'careful', class: 'M' } }, undefined)).toBe(
      'M · careful',
    );
  });
});
