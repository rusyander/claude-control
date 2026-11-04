import { describe, expect, it } from 'vitest';
import type { SplitGroupStatus, SplitPlanRecord } from '../../../lib/app-store/app-store.types.ts';
import { legacyGroupRuns, legacyRunState } from './legacy-runs.ts';

function plan(
  id: string,
  statuses: SplitGroupStatus[],
  extra: Partial<SplitPlanRecord> = {},
): SplitPlanRecord {
  return {
    parentChatId: id,
    projectPath: '/repo',
    copyRoot: '/copies',
    createdAt: `2026-10-0${statuses.length}T00:00:00.000Z`,
    order: statuses.map((_, i) => i),
    request: {},
    proposal: { shared: 'секретный запрос', groups: [] },
    groups: statuses.map((status, index) => ({
      index,
      title: `g${index}`,
      branch: `b${index}`,
      after: [],
      status,
      chatId: `chat-${index}`,
      path: `/copies/${index}`,
    })),
    ...extra,
  };
}

describe('legacy group runs (stage 10, F1: read-only, never adopted)', () => {
  it('a run with a group still going is half-run, not finished', () => {
    expect(legacyRunState(plan('a', ['started', 'done']))).toBe('half-run');
    expect(legacyRunState(plan('a', ['waiting']))).toBe('half-run');
    expect(legacyRunState(plan('a', ['paused', 'failed']))).toBe('half-run');
  });

  it('every group done or failed is finished; cancelledAt wins over statuses; no groups is half-run', () => {
    expect(legacyRunState(plan('a', ['done', 'failed']))).toBe('finished');
    expect(legacyRunState(plan('a', ['started'], { cancelledAt: '2026-10-02' }))).toBe('cancelled');
    expect(legacyRunState(plan('a', []))).toBe('half-run');
  });

  it('only title, branch and status leave the fold — no copy, chat or request; newest first', () => {
    const runs = legacyGroupRuns({ a: plan('a', ['done']), b: plan('b', ['started', 'done']) });
    expect(runs.map((r) => r.parentChatId)).toEqual(['b', 'a']);
    expect(runs[0]!.groups).toEqual([
      { title: 'g0', branch: 'b0', status: 'started' },
      { title: 'g1', branch: 'b1', status: 'done' },
    ]);
    const wire = JSON.stringify(runs);
    expect(wire).not.toMatch(/copies|chat-|секретный/);
  });
});
