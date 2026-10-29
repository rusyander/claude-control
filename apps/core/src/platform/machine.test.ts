import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  diskFree,
  diskVerdict,
  existsVia,
  isTcc,
  memFree,
  memVerdict,
  readMemory,
  realMachineIo,
  repoAccess,
} from './machine.ts';
import type { MachineIo } from './machine.types.ts';

/**
 * Факты машины (04:114-117, P44, P106): чтение диска и доступа к папке — только через readFact,
 * сбой — `unknown`, «нет» — только ENOENT. EPERM на macOS — TCC, названный как TCC; на других
 * системах тот же EPERM — обычный `unknown`. Порог диска: 10 ГБ или 5 %, что меньше.
 */

const scratch = mkdtempSync(join(tmpdir(), 'agentdeck-core-machine-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const GiB = 1024 ** 3;
// readFact сам ставит код впереди сообщения: `EPERM: refused`.
const err = (code: string) => Object.assign(new Error('refused'), { code });
const fireNow = (fn: () => void) => {
  queueMicrotask(fn);
  return { cancel: () => undefined };
};

function io(over: Partial<MachineIo>): MachineIo {
  return { ...realMachineIo, ...over };
}

describe('machine.disk', () => {
  it('reads the real volume of a temp dir; a missing path is absent', async () => {
    const real = await diskFree(scratch);
    expect('value' in real && real.value.totalBytes > 0).toBe(true);
    expect(await diskFree(join(scratch, 'gone'))).toEqual({ absent: true });
  });

  it('faults are unknown: EPERM, garbage figures, timeout', async () => {
    expect(
      await diskFree(scratch, io({ statfs: async () => Promise.reject(err('EPERM')) })),
    ).toEqual({ unknown: 'EPERM: refused' });
    const garbage = await diskFree(
      scratch,
      io({ statfs: async () => ({ bavail: 10, blocks: 5, bsize: 1 }) }),
    );
    expect('unknown' in garbage && garbage.unknown).toMatch(/^garbage/);
    const hung = await diskFree(scratch, io({ statfs: () => new Promise(() => undefined) }), {
      setTimer: fireNow,
    });
    expect(hung).toEqual({ unknown: 'timeout after 5000 ms' });
  });

  it('the verdict: low below min(10 GB, 5 %); unknown is a named doubt, not a block', () => {
    const fact = (free: number, total: number) => ({
      value: { freeBytes: free, totalBytes: total },
    });
    expect(diskVerdict(fact(9 * GiB, 1000 * GiB)).kind).toBe('low');
    expect(diskVerdict(fact(11 * GiB, 1000 * GiB)).kind).toBe('ok');
    // Маленький том: 5 % от 100 ГБ = 5 ГБ — порог ниже 10 ГБ.
    expect(diskVerdict(fact(6 * GiB, 100 * GiB)).kind).toBe('ok');
    expect(diskVerdict(fact(4 * GiB, 100 * GiB))).toMatchObject({
      kind: 'low',
      thresholdBytes: 5 * GiB,
    });
    expect(diskVerdict({ unknown: 'EIO' })).toEqual({ kind: 'doubt', reason: 'EIO' });
  });
});

describe('memory', () => {
  it('reads real memory; garbage and throws are unknown; low lowers slots', () => {
    expect('value' in memFree()).toBe(true);
    expect(memFree(io({ memory: () => ({ free: Number.NaN, total: 1 }) }))).toEqual({
      unknown: 'garbage: memory figures',
    });
    expect(
      memFree(
        io({
          memory: () => {
            throw new Error('boom');
          },
        }),
      ),
    ).toEqual({ unknown: 'memory: boom' });
    expect(memVerdict({ value: { freeBytes: 1 * GiB, totalBytes: 32 * GiB } }).kind).toBe('low');
    expect(memVerdict({ value: { freeBytes: 8 * GiB, totalBytes: 32 * GiB } }).kind).toBe('ok');
  });

  it('A2r5-F06: macOS free RAM counts inactive + speculative pages (vm_stat); unreadable vm_stat or free 0 is unknown', () => {
    const vmStat = readFileSync(
      new URL('./__fixtures__/gpu/darwin-vm_stat.txt', import.meta.url),
      'utf8',
    );
    expect(
      readMemory(
        'darwin',
        () => vmStat,
        () => 32 * GiB,
      ),
    ).toEqual({
      free: (81234 + 598765 + 12345) * 16384,
      total: 32 * GiB,
    });
    const mac = (text: string): MachineIo =>
      io({
        memory: () =>
          readMemory(
            'darwin',
            () => text,
            () => 32 * GiB,
          ),
      });
    expect(memFree(mac('Pages free: 1.'))).toEqual({
      unknown: 'memory: vm_stat output unreadable',
    });
    // Ноль свободной памяти — так libuv отвечает на сбой чтения, а не измерение (P44).
    expect(memFree(io({ memory: () => ({ free: 0, total: 16 * GiB }) }))).toEqual({
      unknown: 'garbage: memory figures (free 0)',
    });
    // Не macOS — os.freemem() как есть, vm_stat не зовётся.
    expect(
      readMemory(
        'linux',
        () => {
          throw new Error('vm_stat must not run');
        },
        () => 8 * GiB,
        () => 3 * GiB,
      ),
    ).toEqual({ free: 3 * GiB, total: 8 * GiB });
  });
});

describe('B2r6-F03: absent only on ENOENT, at the enforcer', () => {
  it('existence check: ENOENT → false, EACCES → rejects (never "missing")', async () => {
    const enoent = existsVia(async () => Promise.reject(err('ENOENT')));
    expect(await enoent('/x')).toBe(false);
    const eacces = existsVia(async () => Promise.reject(err('EACCES')));
    await expect(eacces('/x')).rejects.toMatchObject({ code: 'EACCES' });
    expect(await existsVia(async () => ({}))('/x')).toBe(true);
  });

  it('every reader: exists refused with EACCES → unknown, not absent', async () => {
    const refused = io({ exists: async () => Promise.reject(err('EACCES')) });
    expect(await diskFree(scratch, refused)).toEqual({ unknown: 'EACCES: refused' });
    for (const os of ['darwin', 'linux', 'win32'] as const)
      expect(await repoAccess(scratch, refused, os)).toEqual({ unknown: 'EACCES: refused' });
  });
});

describe('repo.access (P106)', () => {
  it('a real folder reads true; a missing one is absent', async () => {
    expect(await repoAccess(scratch)).toEqual({ value: true });
    expect(await repoAccess(join(scratch, 'gone'))).toEqual({ absent: true });
  });

  it('EPERM on macOS is unknown(tcc) naming the folder; on Windows and Linux it is a plain unknown', async () => {
    const eperm = io({ readdir: async () => Promise.reject(err('EPERM')) });
    const mac = await repoAccess(scratch, eperm, 'darwin');
    expect(isTcc(mac)).toBe(true);
    expect('unknown' in mac && mac.unknown).toContain(scratch);
    for (const os of ['win32', 'linux'] as const) {
      const other = await repoAccess(scratch, eperm, os);
      expect(other).toEqual({ unknown: 'EPERM: refused' });
      expect(isTcc(other)).toBe(false);
    }
    const hung = await repoAccess(
      scratch,
      io({ readdir: () => new Promise(() => undefined) }),
      'darwin',
      { setTimer: fireNow },
    );
    expect(hung).toEqual({ unknown: 'timeout after 5000 ms' });
    const garbage = await repoAccess(scratch, io({ readdir: async () => 'x' as never }), 'linux');
    expect(garbage).toEqual({ unknown: 'garbage: directory listing' });
  });
});
