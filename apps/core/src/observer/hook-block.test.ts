import { describe, expect, it } from 'vitest';
import { judgeHookBlock, UNIDENTIFIED_HOOK } from './hook-block.ts';
import {
  HOOK_LOOP_THRESHOLD,
  judgeHookLoop,
  targetDigest,
  type HookRefusalKey,
} from './hook-loop.ts';

/**
 * G-e, 06:121-122 — отказ хука человека: `hook-block` (warn, show) называет хук, инструмент и
 * событие; хук не назван CLI — `unidentified user hook` с кандидатами, а не пропуск. Петля:
 * тот же хук × то же действие 3 раза за ОДИН шаг → `hook-loop` (stop, stop-step), ровно на пороге.
 */

describe('G-e hook-block judge (observer)', () => {
  it('a named hook refusal is a warn hook-block with action show naming hook, tool and event', () => {
    expect(
      judgeHookBlock({ hook: 'guard.sh', event: 'PreToolUse', tool: 'Bash', reason: ' no rm ' }),
    ).toEqual({
      fired: true,
      signal: 'hook-block',
      severity: 'warn',
      action: 'show',
      subject: 'guard.sh',
      detail: 'Bash on PreToolUse: no rm',
      reasons: ['user hook guard.sh refused on PreToolUse'],
    });
  });

  it('an unnamed hook is still a signal: subject unidentified user hook, candidates named', () => {
    const got = judgeHookBlock({
      hook: null,
      event: 'UserPromptSubmit',
      tool: null,
      reason: '',
      candidates: ['UserPromptSubmit:*:lint.sh'],
    });
    expect(got).toMatchObject({
      fired: true,
      subject: UNIDENTIFIED_HOOK,
      detail: 'no tool call on UserPromptSubmit: no reason given',
    });
    expect(got.reasons[0]).toContain('UserPromptSubmit:*:lint.sh');
  });
});

describe('G-e hook-loop judge (observer)', () => {
  const key = (stepId: string, target = targetDigest({ command: 'rm -rf x' })): HookRefusalKey => ({
    stepId,
    hook: 'guard.sh',
    tool: 'Bash',
    target,
  });

  it('the same hook refusing the same action fires stop-step exactly on the 3rd time in one step', () => {
    expect(HOOK_LOOP_THRESHOLD).toBe(3);
    const seen: HookRefusalKey[] = [];
    const fired: boolean[] = [];
    for (let i = 0; i < 4; i += 1) {
      const got = judgeHookLoop(seen, key('s1'));
      fired.push(got.fired);
      seen.push(key('s1'));
    }
    expect(fired).toEqual([false, false, true, false]);
    expect(judgeHookLoop([key('s1'), key('s1')], key('s1'))).toMatchObject({
      signal: 'hook-loop',
      severity: 'stop',
      action: 'stop-step',
      subject: 'guard.sh',
      detail: 'Bash refused 3× by the same hook in this step',
    });
  });

  it('refusals of another step, another target or another hook do not count toward the loop', () => {
    expect(judgeHookLoop([key('s0'), key('s0'), key('s1')], key('s1')).fired).toBe(false);
    const other = key('s1', targetDigest({ command: 'ls' }));
    expect(judgeHookLoop([key('s1'), other], key('s1')).fired).toBe(false);
    expect(judgeHookLoop([key('s1'), { ...key('s1'), hook: null }], key('s1')).fired).toBe(false);
    // Порядок ключей входа не меняет действие.
    expect(targetDigest({ a: 1, b: [2, { c: 3, d: 4 }] })).toBe(
      targetDigest({ b: [2, { d: 4, c: 3 }], a: 1 }),
    );
  });
});
