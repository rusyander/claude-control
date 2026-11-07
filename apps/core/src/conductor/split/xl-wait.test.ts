import { describe, expect, it } from 'vitest';
import { xlParentNext, type XlChild } from './xl-wait.ts';

/** Суд родителя XL (Q-2 s11) на таблице: волна по сданным зависимостям, ожидание, итог. */

const child = (name: string, over: Partial<XlChild> = {}): XlChild => ({
  name,
  deps: [],
  taskId: `t-${name}`,
  refused: null,
  ended: null,
  why: null,
  ...over,
});

const judge = (children: XlChild[]) => xlParentNext({ children, pollMs: 50 }, 1000);

describe('xlParentNext', () => {
  it('a child still running → wait until now + pollMs, naming it', () => {
    expect(judge([child('api'), child('web', { ended: 'done' })])).toEqual({
      kind: 'wait',
      reason: 'XL parent waits for its children: api',
      untilWallMs: 1050,
    });
  });

  it('a dependent is launched only once every dependency is done', () => {
    const web = child('web', { deps: ['api'], taskId: null });
    expect(judge([child('api'), web]).kind).toBe('wait');
    expect(judge([child('api', { ended: 'done' }), web])).toEqual({
      kind: 'launch-children',
      names: ['web'],
    });
  });

  it('all done → finish; a refused, failed or never-started child → fail naming each', () => {
    expect(judge([child('api', { ended: 'done' })])).toEqual({ kind: 'finish-task' });
    const out = judge([
      child('api', { ended: 'failed', why: 'tests red' }),
      child('web', { deps: ['api'], taskId: null }),
      child('bad', { taskId: null, refused: 'no repos' }),
      child('docs', { ended: 'cancelled' }),
    ]);
    expect(out).toEqual({
      kind: 'fail-task',
      reason:
        'child api (t-api) failed: tests red; ' +
        'child web never started: its dependencies api did not finish done; ' +
        'child bad refused at creation: no repos; ' +
        'child docs (t-docs) cancelled',
    });
  });
});
