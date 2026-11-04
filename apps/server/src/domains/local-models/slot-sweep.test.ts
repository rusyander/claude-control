import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_SLOT_AGE_MS, MAX_SLOT_FILES, slotFileOf, sweepSlotDir } from './slot-sweep.ts';

/**
 * Уборка каталога слотов (L8): файлы и описания кладутся в той форме, в какой их пишет кеш слота
 * ядра (`apps/core/src/platform/slot-cache.ts`); каталог — временный, настоящий.
 */

const SHAPE = 'model-a|131072|q4_0|tpl1';
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'slot-sweep-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function saved(session: string, savedAt: number, shape = SHAPE, bytes = 16): void {
  writeFileSync(join(dir, slotFileOf(session)), Buffer.alloc(bytes));
  writeFileSync(
    join(dir, slotFileOf(session).replace(/\.bin$/, '.json')),
    JSON.stringify({ session, shape, tokens: 20_000, savedAt }),
  );
}

const has = (name: string): boolean => existsSync(join(dir, name));

describe('slot-sweep: уборка каталога слотов', () => {
  it('файл старше срока уходит вместе с описанием, свежий остаётся', () => {
    const now = 10 * MAX_SLOT_AGE_MS;
    saved('old', now - MAX_SLOT_AGE_MS - 1);
    saved('fresh', now - MAX_SLOT_AGE_MS + 1_000);
    sweepSlotDir({ dir, shape: SHAPE, now });
    expect(has('old.bin')).toBe(false);
    expect(has('old.json')).toBe(false);
    expect(has('fresh.bin')).toBe(true);
  });

  it('.bin без описания (запись оборвалась, файл замера) уходит, описанный остаётся', () => {
    saved('A', 1_000);
    writeFileSync(join(dir, 'l8-probe.bin'), Buffer.alloc(8));
    sweepSlotDir({ dir, shape: SHAPE, now: 2_000 });
    expect(has('l8-probe.bin')).toBe(false);
    expect(has('A.bin')).toBe(true);
  });

  it('нечитаемое описание уходит', () => {
    writeFileSync(join(dir, 'broken.json'), '{');
    sweepSlotDir({ dir, shape: SHAPE, now: 2_000 });
    expect(has('broken.json')).toBe(false);
  });

  it('сервер не поднят — файл другого запуска не судится по запуску; поднят другой — уходит', () => {
    saved('A', 1_000);
    sweepSlotDir({ dir, shape: undefined, now: 2_000 });
    expect(has('A.bin')).toBe(true);
    sweepSlotDir({ dir, shape: 'model-b|131072|q4_0|tpl1', now: 2_000 });
    expect(has('A.bin')).toBe(false);
  });

  it(`файлов не больше ${MAX_SLOT_FILES}: самые давние уходят`, () => {
    for (let index = 0; index <= MAX_SLOT_FILES; index += 1) saved(`S${index}`, 1_000 + index);
    sweepSlotDir({ dir, shape: SHAPE, now: 5_000 });
    expect(has('S0.bin')).toBe(false);
    expect(has(`S${MAX_SLOT_FILES}.bin`)).toBe(true);
  });

  it('пустой .bin (запись не дошла) уходит вместе с описанием', () => {
    saved('empty', 1_000, SHAPE, 0);
    sweepSlotDir({ dir, shape: SHAPE, now: 2_000 });
    expect(has('empty.json')).toBe(false);
  });

  it('каталога нет — уборка молчит', () => {
    rmSync(dir, { recursive: true, force: true });
    expect(() => sweepSlotDir({ dir, shape: SHAPE, now: 1 })).not.toThrow();
  });
});
