import { describe, expect, it } from 'vitest';
import { watcherSpendText } from './spend';

const spend = { input: 1000, output: 200, cacheRead: 3000, cacheCreation: 800, runs: 2 };

describe('расход наблюдателя', () => {
  it('токены — все четыре слагаемых, без подписи об оценке', () => {
    expect(watcherSpendText(spend, 'tokens')).toEqual({ text: '5.0k tok', estimate: false });
    expect(watcherSpendText({ ...spend, estimatedUsd: 0.5 }, 'tokens').estimate).toBe(false);
  });

  it('деньги — с подписью об оценке; прайса нет — токены, а не «$0.000»', () => {
    expect(watcherSpendText({ ...spend, estimatedUsd: 0.0123 }, 'money')).toEqual({
      text: '$0.012',
      estimate: true,
    });
    expect(watcherSpendText(spend, 'money')).toEqual({ text: '5.0k tok', estimate: false });
  });
});
