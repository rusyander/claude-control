import { spawnSync } from 'node:child_process';
import { readdir, stat, statfs } from 'node:fs/promises';
import { freemem, totalmem } from 'node:os';
import type { Fact } from '@agentdeck/contracts/core/facts';
import { absent, readFact, type ReadOptions } from '../lib/facts/read-fact.ts';
import type {
  DiskSpace,
  DiskThreshold,
  DiskVerdict,
  MachineIo,
  MemSpace,
  MemThreshold,
  MemVerdict,
} from './machine.types.ts';
import { currentOs, type OsKind } from './os-kind.ts';

/**
 * Факты машины (04:114-117, 09): свободный диск, память, доступ к папке репозитория. Различие
 * систем живёт здесь (P51): на macOS EPERM при чтении папки репозитория — это TCC (защита
 * «Документов», «Рабочего стола», съёмных томов), ответ `unknown(tcc)` с названной причиной и
 * путём исправления, а не «папки нет» (P106). Порог диска и памяти судится тоже здесь — одна
 * функция на решение (P01), её зовут и очередь проверок, и сервисы, и предполётная проверка.
 */

export const DEFAULT_DISK_THRESHOLD: DiskThreshold = {
  minBytes: 10 * 1024 ** 3,
  minFraction: 0.05,
};
export const DEFAULT_MEM_THRESHOLD: MemThreshold = { minBytes: 2 * 1024 ** 3, minFraction: 0.1 };

/** Есть ли путь: `false` — только ENOENT; любой другой отказ (EACCES, TCC) пробрасывается (P44). */
export function existsVia(statPath: (path: string) => Promise<unknown>) {
  return async (path: string): Promise<boolean> => {
    try {
      await statPath(path);
      return true;
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return false;
      throw error;
    }
  };
}

/**
 * Свободные байты по выводу `vm_stat`: free + inactive + speculative — страницы, которые macOS
 * отдаёт по первому требованию (09:37). Нет размера страницы или счётчиков — `undefined`, не ноль.
 */
export function darwinFreeBytes(vmStat: string): number | undefined {
  const page = /page size of (\d+) bytes/.exec(vmStat)?.[1];
  if (page === undefined || Number(page) <= 0) return undefined;
  const pages = (label: string): number | undefined => {
    const hit = new RegExp(`^${label}:\\s+(\\d+)\\.`, 'm').exec(vmStat)?.[1];
    return hit === undefined ? undefined : Number(hit);
  };
  const free = pages('Pages free');
  const inactive = pages('Pages inactive');
  if (free === undefined || inactive === undefined) return undefined;
  return (free + inactive + (pages('Pages speculative') ?? 0)) * Number(page);
}

function runVmStat(): string {
  // Синхронно: `memFree` зовут синхронно очередь и предполётная проверка; vm_stat — миллисекунды.
  const run = spawnSync('vm_stat', [], { encoding: 'utf8', timeout: 2000, windowsHide: true });
  if (run.error) throw new Error(`vm_stat: ${run.error.message}`);
  if (run.status !== 0) throw new Error(`vm_stat exit ${run.status ?? run.signal}`);
  return run.stdout;
}

/**
 * Память машины. macOS: `os.freemem()` — только свободные страницы (libuv `free_count`), на Mac это
 * почти всегда «мало»; поэтому `vm_stat` с неактивными страницами (A2r5-F06).
 */
export function readMemory(
  os: OsKind = currentOs(),
  vmStat: () => string = runVmStat,
  total: () => number = totalmem,
  free: () => number = freemem,
): { free: number; total: number } {
  if (os !== 'darwin') return { free: free(), total: total() };
  const bytes = darwinFreeBytes(vmStat());
  if (bytes === undefined) throw new Error('vm_stat output unreadable');
  return { free: bytes, total: total() };
}

export const realMachineIo: MachineIo = {
  statfs: (path) => statfs(path),
  memory: () => readMemory(),
  exists: existsVia((path) => stat(path)),
  readdir: (path) => readdir(path),
};

function num(v: number | bigint): number {
  return typeof v === 'bigint' ? Number(v) : v;
}

function finiteNonNegative(n: number): boolean {
  return Number.isFinite(n) && n >= 0;
}

/** Свободное место тома, где лежит `path` (класс `machine.disk`). */
export function diskFree(
  path: string,
  io: MachineIo = realMachineIo,
  options: ReadOptions<DiskSpace> = {},
): Promise<Fact<DiskSpace>> {
  return readFact(
    'machine.disk',
    async () => {
      if (!(await io.exists(path))) return absent();
      const s = await io.statfs(path);
      const bsize = num(s.bsize);
      return { freeBytes: num(s.bavail) * bsize, totalBytes: num(s.blocks) * bsize };
    },
    {
      ...options,
      validate: (v) =>
        finiteNonNegative(v.freeBytes) &&
        finiteNonNegative(v.totalBytes) &&
        v.totalBytes > 0 &&
        v.freeBytes <= v.totalBytes &&
        (options.validate?.(v) ?? true),
    },
  );
}

/** Свободная память; без своего класса чтения — это не внешнее чтение, а вызов ОС без IO. */
export function memFree(io: MachineIo = realMachineIo): Fact<MemSpace> {
  try {
    const m = io.memory();
    if (!finiteNonNegative(m.free) || !finiteNonNegative(m.total) || m.total === 0)
      return { unknown: 'garbage: memory figures' };
    // libuv отвечает нулём, когда `host_statistics` / `/proc/meminfo` не прочитались (P44).
    if (m.free === 0) return { unknown: 'garbage: memory figures (free 0)' };
    return { value: { freeBytes: m.free, totalBytes: m.total } };
  } catch (error) {
    return { unknown: `memory: ${(error as Error).message}` };
  }
}

export const TCC_PREFIX = 'tcc';

/**
 * Читается ли папка репозитория (класс `repo.access`). Нет папки — `absent`; EPERM на macOS —
 * `unknown('tcc: …')`: TCC режет чтение, не сообщая, что именно (P106); прочие сбои — `unknown`
 * с кодом. Ответ `true` — только когда каталог реально прочитан.
 */
export function repoAccess(
  path: string,
  io: MachineIo = realMachineIo,
  os: OsKind = currentOs(),
  options: ReadOptions<true> = {},
): Promise<Fact<true>> {
  return readFact(
    'repo.access',
    async () => {
      if (!(await io.exists(path))) return absent();
      try {
        const names = await io.readdir(path);
        if (!Array.isArray(names)) throw new Error('garbage: directory listing');
        return true as const;
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (os === 'darwin' && (code === 'EPERM' || code === 'EACCES'))
          throw new Error(
            `${TCC_PREFIX}: macOS privacy protection refused reading '${path}' (${code})`,
            { cause: error },
          );
        throw error;
      }
    },
    options,
  );
}

export function isTcc(fact: Fact<unknown>): boolean {
  return 'unknown' in fact && fact.unknown.startsWith(`${TCC_PREFIX}:`);
}

function threshold(total: number, t: { minBytes: number; minFraction: number }): number {
  return Math.min(t.minBytes, Math.floor(total * t.minFraction));
}

/** Хватает ли диска на новую копию или контейнер (04:115). Сомнение — не блок, а названный прогон. */
export function diskVerdict(
  fact: Fact<DiskSpace>,
  t: DiskThreshold = DEFAULT_DISK_THRESHOLD,
): DiskVerdict {
  if ('unknown' in fact) return { kind: 'doubt', reason: fact.unknown };
  if ('absent' in fact) return { kind: 'doubt', reason: 'volume path missing' };
  const limit = threshold(fact.value.totalBytes, t);
  return fact.value.freeBytes < limit
    ? { kind: 'low', free: fact.value, thresholdBytes: limit }
    : { kind: 'ok', free: fact.value };
}

/** Мало ли памяти: `low` — слоты новых запусков снижаются (04:116), запуск не запрещён. */
export function memVerdict(
  fact: Fact<MemSpace>,
  t: MemThreshold = DEFAULT_MEM_THRESHOLD,
): MemVerdict {
  if ('unknown' in fact) return { kind: 'doubt', reason: fact.unknown };
  if ('absent' in fact) return { kind: 'doubt', reason: 'memory figures missing' };
  const limit = threshold(fact.value.totalBytes, t);
  return fact.value.freeBytes < limit
    ? { kind: 'low', free: fact.value, thresholdBytes: limit }
    : { kind: 'ok', free: fact.value };
}
