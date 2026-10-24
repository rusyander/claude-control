import { describe, it, expect } from 'vitest';
import type { AppState, SplitPlanRecord } from './app-store.types.ts';
import {
  GROUP_WAIT_RESUMES_MAX,
  getGroupWaitResume,
  setGroupWaitResume,
} from './group-wait-resumes.ts';

/**
 * Срез счёта продолжений группы «по плану» (F-87) конечен: счёт кончившейся
 * группы уходит на любой записи, живых не больше потолка, битая ручная правка
 * `state.json` читается как «счёта нет».
 */

function plan(parent: string, statuses: string[]): SplitPlanRecord {
  return {
    parentChatId: parent,
    projectPath: '',
    createdAt: '2026-10-23T00:00:00.000Z',
    order: statuses.map((_, index) => index),
    request: {},
    proposal: { groups: [] },
    groups: statuses.map((status, index) => ({ index, branch: `b${index}`, status })),
  } as unknown as SplitPlanRecord;
}

const record = (parentChatId: string, groupIndex: number, at: string, count = 1) => ({
  count,
  parentChatId,
  groupIndex,
  at,
});

describe('срез счёта продолжений группы «по плану» (F-87)', () => {
  it('запись и чтение; undefined стирает, пустой срез уходит из состояния', () => {
    const state = { splitPlans: { p: plan('p', ['running']) } } as unknown as AppState;
    setGroupWaitResume(state, 's1', record('p', 0, '2026-10-23T01:00:00.000Z', 2));
    expect(getGroupWaitResume(state, 's1')?.count).toBe(2);
    setGroupWaitResume(state, 's1', undefined);
    expect(getGroupWaitResume(state, 's1')).toBeUndefined();
    expect(state.groupWaitResumes).toBeUndefined();
  });

  it('счёт кончившейся группы (done, failed, план или группа ушли) стирается на любой записи', () => {
    const state = {
      splitPlans: { p: plan('p', ['running', 'done', 'failed']) },
    } as unknown as AppState;
    state.groupWaitResumes = {
      done: record('p', 1, '2026-10-23T01:00:00.000Z'),
      failed: record('p', 2, '2026-10-23T01:00:00.000Z'),
      'no-group': record('p', 7, '2026-10-23T01:00:00.000Z'),
      'no-plan': record('gone', 0, '2026-10-23T01:00:00.000Z'),
    };
    setGroupWaitResume(state, 'live', record('p', 0, '2026-10-23T02:00:00.000Z'));
    expect(Object.keys(state.groupWaitResumes ?? {})).toEqual(['live']);
  });

  it('живых больше потолка не бывает: уходят самые старые', () => {
    const state = { splitPlans: { p: plan('p', ['running']) } } as unknown as AppState;
    for (let index = 0; index <= GROUP_WAIT_RESUMES_MAX; index += 1) {
      const at = new Date(Date.UTC(2026, 9, 23, 0, 0, index)).toISOString();
      setGroupWaitResume(state, `s${index}`, record('p', 0, at));
    }
    expect(Object.keys(state.groupWaitResumes ?? {})).toHaveLength(GROUP_WAIT_RESUMES_MAX);
    expect(getGroupWaitResume(state, 's0')).toBeUndefined();
    expect(getGroupWaitResume(state, `s${GROUP_WAIT_RESUMES_MAX}`)).toBeDefined();
  });

  it('битая ручная правка и ключи прототипа — как «счёта нет»', () => {
    const state = {
      groupWaitResumes: { broken: { count: 'три' }, zero: { count: 0 } },
    } as unknown as AppState;
    expect(getGroupWaitResume(state, 'broken')).toBeUndefined();
    expect(getGroupWaitResume(state, 'zero')).toBeUndefined();
    expect(getGroupWaitResume(state, '__proto__')).toBeUndefined();
    expect(getGroupWaitResume(state, 'constructor')).toBeUndefined();
  });
});
