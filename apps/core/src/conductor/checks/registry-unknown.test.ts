import { afterEach, describe, expect, it } from 'vitest';
import { READ_CLASSES } from '../../lib/facts/read-classes.ts';
import { makeHarness, type Harness } from './__fixtures__/harness.ts';

/**
 * fix-w2R-X01: класс чтения `check.registry` и поведение входа проверки — один ответ. Реестр —
 * источник команды: без него ядру нечего гонить и нечего пропускать, поэтому неизвестный реестр —
 * именованный отказ `registry-unreadable` (ни прогона, ни записи-зелёного), а не «прогон». Тест
 * сверяет объявленное действие класса с ответом настоящего сервиса: разойдись контракт (`run`) или
 * код (прогон/пропуск) — красный.
 */

const open: Harness[] = [];
afterEach(() => {
  for (const h of open.splice(0)) h.close();
});

describe('check.registry unknown: the read class and the check entry agree (fix-w2R-X01)', () => {
  it('an unreadable registry refuses by name on the checkId and argv roads, spawns nothing, as its read class declares', async () => {
    expect(READ_CLASSES['check.registry'].onUnknown).toBe('refuse');
    const h = await makeHarness({ registry: { unknown: 'profile unreadable' } });
    open.push(h);
    h.mode('pass');
    const byId = await h.service.requestCheck(h.req());
    const byArgv = await h.service.requestCheck(
      h.req({ road: 'capture-wrapper', checkId: undefined, argv: ['node', 'x.mjs'], unit: '' }),
    );
    for (const answer of [byId, byArgv]) {
      expect(answer.kind).toBe(READ_CLASSES['check.registry'].onUnknown);
      expect(answer).toMatchObject({ unmet: [{ code: 'registry-unreadable' }] });
    }
    expect(h.spawns()).toEqual([]);
  });
});
