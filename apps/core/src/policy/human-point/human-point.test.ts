import { describe, expect, it } from 'vitest';
import { decideHumanPoint } from './human-point.ts';
import type { HumanPointInput, HumanPointPolicy } from './human-point.types.ts';

/**
 * Пункты человека (06 §Human points, core-s2 F-46, F-06): пункты 1–4 блокируют всегда —
 * `blocking:false` модели их не снимает; класс путей человека совпадает и для абсолютной цели
 * и для `./…` — по хвостам пути, как маска `.gitignore`.
 */

const policy: HumanPointPolicy = {
  actionClasses: [],
  pathGlobs: ['/migrations', '*.env'],
  grantRequired: [{ globs: ['db/*.sql'], ops: ['edit'] }],
  trackerWrites: 'auto',
  forgeWrites: 'auto',
};

const ask = (action: HumanPointInput['action'], blocking: boolean): HumanPointInput => ({
  source: 'ask_human',
  point: null,
  action,
  question: 'q',
  options: ['a', 'b'],
  recommendation: 'a',
  blocking,
});

describe('human points — items 1–4 block whatever the model says (F-46)', () => {
  it.each([
    ['merge', 1],
    ['remote-delete', 2],
    ['db-write', 3],
    ['credential', 4],
  ] as const)('%s with blocking:false → item %s, blocking', (kind, item) => {
    expect(decideHumanPoint(ask({ kind, target: 'x' }, false), policy)).toMatchObject({
      point: item,
      blocking: true,
    });
  });
});

describe('human points — path classes match absolute and ./ targets (F-46, F-06)', () => {
  it.each([
    ['migrations/1.sql', 5],
    ['./migrations/1.sql', 5],
    ['C:\\work\\copy\\migrations\\1.sql', 5],
    ['/home/u/copy/migrations/1.sql', 5],
    ['apps/a/prod.env', 5],
    ['/home/u/copy/db/x.sql', 5],
    ['src/index.ts', null],
  ] as const)('%s → point %s', (target, point) => {
    expect(decideHumanPoint(ask({ kind: 'path', target }, true), policy)).toMatchObject({ point });
  });
});
