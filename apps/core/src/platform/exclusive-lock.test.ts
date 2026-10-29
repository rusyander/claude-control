import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  acquireExclusive,
  holdsExclusive,
  ownsExclusive,
  readHolder,
  releaseExclusive,
  type LockDeps,
  type LockHolder,
} from './exclusive-lock.ts';

let root = '';
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'exclusive lock ü '));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const holder = (leaseId: string, pid = 999_999): LockHolder => ({
  leaseId,
  pid,
  pidStart: 'start',
  bootId: 'boot',
  build: 'test',
  acquiredAt: 0,
});

/** Держатель «мёртв и молчит» — без проверки чтения файла захват бы прошёл. */
const deadDeps: LockDeps = { isAlive: async () => 'dead', isSilent: () => true, now: Date.now };

describe('P55 exclusive lock — unreadable holder is unknown, never «gone»', () => {
  it('P55 holder file that exists but cannot be read → no takeover, reason names the read failure; ownership unknown; release leaves it', async () => {
    // Каталог на месте файла: `wx` отвечает EEXIST, чтение — EISDIR (на обеих ОС) —
    // настоящий сбой чтения ФС, а не подмена.
    const lock = join(root, 'dir-lock');
    mkdirSync(lock);
    expect(readHolder(lock)).toEqual({ unknown: expect.stringMatching(/^EISDIR/) });
    const got = await acquireExclusive(lock, holder('me'), deadDeps);
    expect(got).toEqual({
      acquired: false,
      holder: undefined,
      reason: expect.stringMatching(/^holder unreadable: EISDIR/),
    });
    expect(ownsExclusive(lock, 'me')).toEqual({ unknown: expect.stringMatching(/^EISDIR/) });
    expect(holdsExclusive(lock, 'me')).toBe(false);
    expect(releaseExclusive(lock, 'me')).toBe(false);
    expect(statSync(lock).isDirectory()).toBe(true);
  });

  it('P55 missing file → absent (free), taken by `wx`; a dead silent holder → taken over through a claim', async () => {
    const lock = join(root, 'file-lock');
    expect(readHolder(lock)).toEqual({ absent: true });
    expect(ownsExclusive(lock, 'me')).toEqual({ value: false });
    expect(await acquireExclusive(lock, holder('me', process.pid), deadDeps)).toEqual({
      acquired: true,
      takeoverOf: null,
    });
    expect(ownsExclusive(lock, 'me')).toEqual({ value: true });
    expect(releaseExclusive(lock, 'me')).toBe(true);
    expect(existsSync(lock)).toBe(false);

    writeFileSync(lock, JSON.stringify(holder('old')));
    const read = readHolder(lock);
    expect(read).toMatchObject({ value: { key: 'old', holder: { leaseId: 'old' } } });
    expect(await acquireExclusive(lock, holder('new', process.pid), deadDeps)).toEqual({
      acquired: true,
      takeoverOf: 'old',
    });
    expect(holdsExclusive(lock, 'new')).toBe(true);
  });

  it('P55 takeover claim that cannot be read → refused with the read failure, holder kept', async () => {
    const lock = join(root, 'claim-lock');
    writeFileSync(lock, JSON.stringify(holder('x')));
    mkdirSync(`${lock}.x.claim-1`);
    const got = await acquireExclusive(lock, holder('me', process.pid), deadDeps);
    expect(got).toMatchObject({
      acquired: false,
      holder: { leaseId: 'x' },
      reason: expect.stringMatching(/^takeover claim unreadable: EISDIR/),
    });
    expect(ownsExclusive(lock, 'x')).toEqual({ value: true });
  });
});

describe('P55 exclusive lock — takeover races', () => {
  /** Заявки на захват: `<lock>.<key>.claim-<n>`; соперник — держатель заявки. */
  const claim = (lock: string, key: string, n: number) => `${lock}.${key}.claim-${n}`;

  it('P55 the same leaseId re-acquires its own file; a live or a still-talking holder is kept (held)', async () => {
    const lock = join(root, 'own-lock');
    writeFileSync(lock, JSON.stringify(holder('me')));
    expect(await acquireExclusive(lock, holder('me'), deadDeps)).toEqual({
      acquired: true,
      takeoverOf: null,
    });
    const alive: LockDeps = { ...deadDeps, isAlive: async () => 'alive' };
    expect(await acquireExclusive(lock, holder('other'), alive)).toMatchObject({
      acquired: false,
      reason: 'held',
      holder: { leaseId: 'me' },
    });
    const talking: LockDeps = { ...deadDeps, isSilent: () => false };
    expect(await acquireExclusive(lock, holder('other'), talking)).toMatchObject({
      acquired: false,
      reason: 'held',
    });
  });

  it('P55 a garbage holder file is keyed by its content hash; silent long enough → taken over, takeoverOf null', async () => {
    const lock = join(root, 'garbage-lock');
    writeFileSync(lock, '{"leaseId": 7}');
    const read = readHolder(lock);
    if (!('value' in read)) throw new Error(JSON.stringify(read));
    expect(read.value.holder).toBeUndefined();
    expect(read.value.key).toMatch(/^raw-[0-9a-f]{16}$/);
    expect(await acquireExclusive(lock, holder('me'), deadDeps)).toEqual({
      acquired: true,
      takeoverOf: null,
    });
    // Заявка на прежнего держателя убрана после перехвата (F-113).
    expect(existsSync(claim(lock, read.value.key, 1))).toBe(false);
    expect(ownsExclusive(lock, 'me')).toEqual({ value: true });
  });

  it('P55 rival claims: a live rival → takeover in progress; a garbage claim → refused; a dead rival → the next claim number is tried', async () => {
    const lock = join(root, 'rival-lock');
    writeFileSync(lock, JSON.stringify(holder('x')));
    writeFileSync(claim(lock, 'x', 1), JSON.stringify(holder('rival', 4242)));
    const rivalAlive: LockDeps = {
      ...deadDeps,
      isAlive: async ({ pid }) => (pid === 4242 ? 'alive' : 'dead'),
    };
    expect(await acquireExclusive(lock, holder('me'), rivalAlive)).toMatchObject({
      acquired: false,
      reason: 'takeover in progress',
      holder: { leaseId: 'rival' },
    });
    expect(await acquireExclusive(lock, holder('me'), deadDeps)).toEqual({
      acquired: true,
      takeoverOf: 'x',
    });
    // Победила вторая заявка (первая — мёртвого соперника); обе убраны после перехвата (F-113).
    expect(existsSync(claim(lock, 'x', 1))).toBe(false);
    expect(existsSync(claim(lock, 'x', 2))).toBe(false);

    const junk = join(root, 'junk-claim-lock');
    writeFileSync(junk, JSON.stringify(holder('y')));
    writeFileSync(claim(junk, 'y', 1), 'not json');
    expect(await acquireExclusive(junk, holder('me'), deadDeps)).toMatchObject({
      acquired: false,
      reason: 'takeover claim unreadable',
      holder: { leaseId: 'y' },
    });
  });

  it('P55 64 dead claims on the same holder → refused (too many dead claims), file untouched', async () => {
    const lock = join(root, 'many-lock');
    writeFileSync(lock, JSON.stringify(holder('z')));
    for (let n = 1; n <= 64; n += 1)
      writeFileSync(claim(lock, 'z', n), JSON.stringify(holder(`r${n}`)));
    expect(await acquireExclusive(lock, holder('me'), deadDeps)).toMatchObject({
      acquired: false,
      reason: 'too many dead claims',
    });
    expect(ownsExclusive(lock, 'z')).toEqual({ value: true });
  });

  /** Между заявкой и повторным чтением файл меняют: колбэк живости соперника — то самое окно. */
  async function raced(name: string, change: (lock: string) => void) {
    const lock = join(root, name);
    writeFileSync(lock, JSON.stringify(holder('w')));
    writeFileSync(claim(lock, 'w', 1), JSON.stringify(holder('rival', 4343)));
    const deps: LockDeps = {
      ...deadDeps,
      isAlive: async ({ pid }) => {
        if (pid === 4343) change(lock);
        return 'dead';
      },
    };
    return { lock, got: await acquireExclusive(lock, holder('me'), deps) };
  }

  it('P55 the holder file changes, vanishes or turns unreadable during the takeover → not taken, the new state is not overwritten', async () => {
    const changed = await raced('race-changed', (lock) =>
      writeFileSync(lock, JSON.stringify(holder('fresh'))),
    );
    expect(changed.got).toMatchObject({
      acquired: false,
      reason: 'holder changed during takeover',
      holder: { leaseId: 'fresh' },
    });
    expect(ownsExclusive(changed.lock, 'fresh')).toEqual({ value: true });

    const vanished = await raced('race-vanished', (lock) => rmSync(lock));
    expect(vanished.got).toEqual({
      acquired: false,
      holder: undefined,
      reason: 'holder changed during takeover',
    });
    expect(existsSync(vanished.lock)).toBe(false);

    const unreadable = await raced('race-unreadable', (lock) => {
      rmSync(lock);
      mkdirSync(lock);
    });
    expect(unreadable.got).toMatchObject({
      acquired: false,
      holder: { leaseId: 'w' },
      reason: expect.stringMatching(/^holder unreadable during takeover: EISDIR/),
    });
  });
});
