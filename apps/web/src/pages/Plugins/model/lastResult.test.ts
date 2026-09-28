import { describe, expect, it } from 'vitest';
import { lastResult } from './lastResult';

const ok = { ok: true, output: 'ok', needsRestart: true };
const failed = { ok: false, output: 'отказ', needsRestart: false };

describe('lastResult', () => {
  it('берёт итог последней отправленной команды, а не первой по списку', () => {
    expect(
      lastResult([
        { data: ok, submittedAt: 1 },
        { data: failed, submittedAt: 2 },
      ]),
    ).toBe(failed);
  });

  it('команды без итога не считаются; нет итогов — пусто', () => {
    expect(lastResult([{ submittedAt: 5 }, { data: ok, submittedAt: 1 }])).toBe(ok);
    expect(lastResult([{ submittedAt: 5 }])).toBeUndefined();
  });
});
