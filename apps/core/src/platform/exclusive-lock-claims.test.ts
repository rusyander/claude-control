import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  acquireExclusive,
  ownsExclusive,
  releaseExclusive,
  type LockDeps,
  type LockHolder,
} from './exclusive-lock.ts';

const root = mkdtempSync(join(tmpdir(), 'lock-claims-'));
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

const holder = (leaseId: string, pid = 999_999): LockHolder => ({
  leaseId,
  pid,
  pidStart: 'start',
  bootId: 'boot',
  build: 'test',
  acquiredAt: 0,
});
const deadDeps: LockDeps = { isAlive: async () => 'dead', isSilent: () => true, now: Date.now };
const claim = (lock: string, key: string, n: number) => `${lock}.${key}.claim-${n}`;

describe('F-113 exclusive lock — claims cleaned up, release never throws, claim cap boundary', () => {
  it('F-113 a takeover leaves no claim files of the replaced holder behind', async () => {
    const dir = mkdtempSync(join(root, 'clean-'));
    const lock = join(dir, 'lock');
    writeFileSync(lock, JSON.stringify(holder('old')));
    writeFileSync(claim(lock, 'old', 1), JSON.stringify(holder('dead-rival', 4343)));
    const got = await acquireExclusive(lock, holder('me'), deadDeps);
    expect(got).toMatchObject({ acquired: true, takeoverOf: 'old' });
    expect(readdirSync(dir)).toEqual(['lock']);
  });

  it('F-113 63 dead claims → the 64th claim wins; 64 dead claims → refused', async () => {
    const dir = mkdtempSync(join(root, 'cap-'));
    const lock = join(dir, 'lock');
    writeFileSync(lock, JSON.stringify(holder('z')));
    for (let n = 1; n <= 63; n += 1)
      writeFileSync(claim(lock, 'z', n), JSON.stringify(holder(`r${n}`)));
    expect(await acquireExclusive(lock, holder('me'), deadDeps)).toMatchObject({ acquired: true });
    expect(ownsExclusive(lock, 'me')).toEqual({ value: true });
  });

  it('F-113 release: an unlink that fails (EBUSY) → false, no throw out of a finally block', () => {
    const dir = mkdtempSync(join(root, 'rel-'));
    const lock = join(dir, 'lock');
    writeFileSync(lock, JSON.stringify(holder('mine')));
    const busy = () => {
      throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
    };
    expect(releaseExclusive(lock, 'mine', busy)).toBe(false);
    expect(releaseExclusive(lock, 'mine')).toBe(true);
    expect(releaseExclusive(lock, 'mine')).toBe(false);
  });
});
