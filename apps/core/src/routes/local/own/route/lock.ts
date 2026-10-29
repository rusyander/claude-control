import { join } from 'node:path';
import { newId } from '../../../../lib/ids/uuidv7.ts';
import {
  acquireExclusive,
  releaseExclusive,
  type LockDeps,
} from '../../../../platform/exclusive-lock.ts';
import { ensureDir } from '../../../../platform/safe-io/files.ts';
import type { OwnContext } from './context.ts';

/**
 * Замок каталога аренд между ядрами (F-88): чтение-проверка-запись места ждущего и записи аренды
 * идут под ним — `platform/exclusive-lock.ts`, как перехват аренды журнала. Без него ядро A,
 * прочитавшее «владелец мёртв», снимало бы место (или принимало аренду), которое ядро B между
 * чтением и снятием уже выдало себе. Держится миллисекунды; держатель мёртв по личности и молчит
 * дольше `LOCK_SILENT_MS` — перехватывается.
 */
export const OWN_LOCK_FILE = '.own.lock';
const LOCK_SILENT_MS = 10_000;
const LOCK_WAIT_MS = LOCK_SILENT_MS + 5_000;

export type Locked<T> = { done: true; value: T } | { done: false; reason: string };

export async function withOwnLock<T>(
  ctx: OwnContext,
  edit: () => T | Promise<T>,
): Promise<Locked<T>> {
  const { workRoot } = ctx.options;
  ensureDir(workRoot);
  const path = join(workRoot, OWN_LOCK_FILE);
  const me = {
    leaseId: newId(),
    pid: process.pid,
    pidStart: ctx.self?.start ?? 'unknown:',
    bootId: ctx.bootId,
    build: 'local:own',
    acquiredAt: Date.now(),
  };
  const deps: LockDeps = {
    // Номер без доказанного старта — «неизвестно»: такой держатель не перехватывается.
    isAlive: async (id) => {
      const read = await ctx.liveness(id, { fresh: true });
      return read.live === 'absent' ? 'dead' : read.live;
    },
    isSilent: (_holder, ageMs) => ageMs > LOCK_SILENT_MS,
    now: Date.now,
  };
  const deadline = Date.now() + LOCK_WAIT_MS;
  let reason = 'not tried';
  for (let attempt = 0; attempt === 0 || Date.now() < deadline; attempt += 1) {
    const got = await acquireExclusive(path, me, deps);
    if (got.acquired) {
      try {
        return { done: true, value: await edit() };
      } finally {
        releaseExclusive(path, me.leaseId);
      }
    }
    reason = got.reason;
    // Ждём, не блокируя цикл событий: чужое ядро правит каталог миллисекунды.
    await new Promise((done) => setTimeout(done, 15 + (attempt % 5) * 5));
  }
  return { done: false, reason: `own lock not acquired in ${LOCK_WAIT_MS} ms: ${reason}` };
}
