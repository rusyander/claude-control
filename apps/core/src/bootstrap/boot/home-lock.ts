import {
  acquireExclusive,
  releaseExclusive,
  type LockDeps,
  type LockHolder,
} from '../../platform/exclusive-lock.ts';

/**
 * Одно ядро на дом (дефект этапа 10): замок `<home>/core.lock`. Без него второе ядро вставало
 * рядом с первым — стенд с ядром и сторож панели запустили оба, — и два процесса писали одни
 * журналы задач, одну `procs.json` и по-своему вели одни аренды.
 *
 * Держатель мёртв (pid + старт процесса от ОС, то же доказательство, что у аренды задачи) —
 * замок перехватывается сразу, без выдержки: ядро не «молчит», оно либо живо, либо нет.
 * Жизнь держателя не доказана (`unknown`) — не перехватываем: второе ядро хуже отказа.
 */

export class CoreHomeBusy extends Error {
  readonly holderPid: number | null;
  constructor(home: string, reason: string, holderPid: number | null) {
    super(
      `core already running for this home (${home}): ${reason}${
        holderPid === null ? '' : `, pid ${holderPid}`
      }`,
    );
    this.name = 'CoreHomeBusy';
    this.holderPid = holderPid;
  }
}

export interface HomeLock {
  release(): boolean;
}

export async function takeHomeLock(
  path: string,
  home: string,
  me: LockHolder,
  isAlive: LockDeps['isAlive'],
): Promise<HomeLock> {
  const outcome = await acquireExclusive(path, me, {
    isAlive,
    isSilent: () => true,
    now: Date.now,
  });
  if (!outcome.acquired) throw new CoreHomeBusy(home, outcome.reason, outcome.holder?.pid ?? null);
  let released = false;
  return {
    release: () => {
      if (released) return false;
      released = true;
      return releaseExclusive(path, me.leaseId);
    },
  };
}
