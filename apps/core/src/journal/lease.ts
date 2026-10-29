import { join } from 'node:path';
import { newId } from '../lib/ids/uuidv7.ts';
import {
  acquireExclusive,
  holdsExclusive,
  ownsExclusive,
  releaseExclusive,
  type LockHolder,
} from '../platform/exclusive-lock.ts';
import { openAppendLog, readTail, type AppendLog } from '../platform/safe-io/append-log.ts';
import { fileSize, renamePath, SINGLE_ATTEMPT } from '../platform/safe-io/files.ts';
import { TASK_FILES, type CoreIdentity, type IsAlive } from './journal.types.ts';

/**
 * Аренда задачи — один писатель (01 §Lease, R:S2-22). Владелец — ядро, чей `owner.json` лежит в
 * каталоге задачи; удары сердца — дописыванием в `beats.log` каждые 5 с (горячий файл никогда
 * не переписывается). Устаревшая = нет удара 15 с И процесс по pid + старту мёртв; `unknown`
 * про жизнь — не устаревшая. Перехват — заявкой `wx` (`platform/exclusive-lock.ts`).
 * Владелец сверяет `owner.json` на каждом ударе и перед каждой записью: перехваченный — больше
 * не пишет (`LeaseLostError`).
 */

export const BEAT_MS = 5_000;
export const STALE_MS = 15_000;
/** `beats.log` больше — одно поколение уходит в `beats.1.log`. */
export const BEATS_ROTATE_BYTES = 64 * 1024;

export interface TaskLease {
  readonly leaseId: string;
  readonly takeoverOf: string | null;
  holds(): boolean;
  beat(): void;
  /** Один удар таймера: сверка владения, удар; ничего не бросает (зовётся из таймера). */
  tick(onLost: () => void): void;
  startBeats(onLost: () => void): void;
  release(): void;
}

/** Первый удар: ждать короткую блокировку файла (антивирус, индексатор) — всего ~1,5 с. */
const FIRST_BEAT_WAITS_MS = [0, 50, 100, 200, 400, 800];
/** Отпуск, не удаливший `owner.json`, повторяется столько раз (по `releaseRetryMs`). */
const RELEASE_RETRIES = 60;

export interface LeaseDeps {
  /**
   * Живость держателя. Судит тот же зонд, что и платформа (F-30): pid, родившийся после
   * снимка тика, зонд перечитывает, а не отвечает «мёртв»; своего кэша у аренды нет.
   */
  isAlive: IsAlive;
  now: () => number;
  /** Пауза между повторами отпуска; по умолчанию — удар сердца. Тесты укорачивают. */
  releaseRetryMs?: number;
}

function lastBeatOf(dir: string, leaseId: string): number | undefined {
  const tail = readTail(join(dir, TASK_FILES.beats), 8 * 1024);
  if (!tail) return undefined;
  const lines = tail.toString('utf8').split('\n').reverse();
  for (const line of lines) {
    if (!line.includes(leaseId)) continue;
    const at = Number(/"at":(\d+)/.exec(line)?.[1]);
    if (Number.isFinite(at)) return at;
  }
  return undefined;
}

/**
 * Аренды, которые держит этот процесс. `owner.json` того же процесса (pid, старт, загрузка),
 * чьего id тут нет, — брошенный своим же: например, отпуск не удалил файл, пока его держал
 * чужой читатель. Такой файл не запирает задачу от собственного ядра (ревью M3).
 */
const heldHere = new Set<string>();

export type LeaseOutcome =
  { ok: true; lease: TaskLease } | { ok: false; holder: LockHolder | undefined; reason: string };

export async function acquireTaskLease(
  dir: string,
  me: CoreIdentity,
  deps: LeaseDeps,
): Promise<LeaseOutcome> {
  const owner = join(dir, TASK_FILES.owner);
  const record: LockHolder = { leaseId: newId(), ...me, acquiredAt: deps.now() };
  const got = await acquireExclusive(owner, record, {
    isAlive: deps.isAlive,
    now: deps.now,
    isOwnLeftover: (holder) =>
      holder.pid === me.pid &&
      holder.pidStart === me.pidStart &&
      holder.bootId === me.bootId &&
      !heldHere.has(holder.leaseId),
    isSilent: (holder, fileAgeMs) => {
      if (!holder) return fileAgeMs > STALE_MS;
      const last = lastBeatOf(dir, holder.leaseId) ?? holder.acquiredAt;
      return deps.now() - last > STALE_MS;
    },
  });
  if (!got.acquired) return { ok: false, holder: got.holder, reason: got.reason };
  heldHere.add(record.leaseId);

  let beats: AppendLog | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let released = false;
  const beatsPath = join(dir, TASK_FILES.beats);
  const lease: TaskLease = {
    leaseId: record.leaseId,
    takeoverOf: got.takeoverOf,
    holds: () => holdsExclusive(owner, record.leaseId),
    beat() {
      const size = fileSize(beatsPath);
      if ('value' in size && size.value > BEATS_ROTATE_BYTES) {
        beats?.close();
        beats = undefined;
        try {
          rotateBeats(dir);
        } catch {
          // Читатель держит `beats.log` без права удаления (EPERM на Windows, каталог только
          // на чтение): удар идёт в старый файл, ротация — на следующем ударе (ревью M4).
        }
      }
      beats ??= openAppendLog(beatsPath);
      beats.append(Buffer.from(`${JSON.stringify({ leaseId: record.leaseId, at: deps.now() })}\n`));
    },
    tick(onLost) {
      try {
        const owns = ownsExclusive(owner, record.leaseId);
        // Файл не прочитан (антивирус, резервная копия открыли его без разделения): владение
        // не доказано ни так, ни так — не потеря; записи сами ждут (`holds()` ложно), следующий
        // удар прочтёт снова (ревью M3: один такой удар отдавал аренду навсегда).
        if (!('value' in owns)) return;
        if (!owns.value) {
          if (timer) clearInterval(timer);
          heldHere.delete(record.leaseId);
          onLost();
          return;
        }
        lease.beat();
      } catch {
        // Исключение из таймера роняет процесс ядра (ревью M4); удар повторится через BEAT_MS.
      }
    },
    startBeats(onLost) {
      try {
        lease.beat();
      } catch {
        // Файл ударов заперт чужим читателем: удар повторит таймер через BEAT_MS (ревью F-24) —
        // исключение здесь бросало открытие задачи уже после записи `lease.acquired`.
      }
      timer = setInterval(() => lease.tick(onLost), BEAT_MS);
      timer.unref?.();
    },
    release() {
      if (released) return;
      released = true;
      if (timer) clearInterval(timer);
      heldHere.delete(record.leaseId);
      try {
        beats?.close();
      } finally {
        beats = undefined;
        // Удаление не вышло (EBUSY антивируса, EPERM) — файл ещё наш: повтор позже, иначе
        // задача заперта для других ядер, пока живо это (ревью F-113, H4).
        if (!releaseExclusive(owner, record.leaseId)) {
          retryRelease(owner, record.leaseId, deps.releaseRetryMs ?? BEAT_MS, RELEASE_RETRIES);
        }
      }
    },
  };
  // Первый удар — после записи owner.json: бросок отсюда оставлял аренду, которую никто не
  // отпустит, и задача была «занята» до рестарта ядра (ревью F-24). Короткую блокировку ждём,
  // долгую — отказ с отпуском аренды.
  if (!(await firstBeat(lease))) {
    lease.release();
    return { ok: false, holder: undefined, reason: 'beats unwritable' };
  }
  return { ok: true, lease };
}

async function firstBeat(lease: TaskLease): Promise<boolean> {
  for (const wait of FIRST_BEAT_WAITS_MS) {
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    try {
      lease.beat();
      return true;
    } catch {
      // Следующая попытка — после паузы; исчерпаны — отказ выше.
    }
  }
  return false;
}

/**
 * Повтор отпуска: пока `owner.json` наш или не прочитан. Чужой (перехват, в том числе своим же
 * процессом как брошенный) или удалённый — повторять нечего: `releaseExclusive` удаляет только
 * файл с нашим `leaseId`. Таймер не держит процесс.
 */
function retryRelease(owner: string, leaseId: string, everyMs: number, left: number): void {
  const owns = ownsExclusive(owner, leaseId);
  if (left <= 0 || ('value' in owns && !owns.value)) return;
  const timer = setTimeout(() => {
    if (!releaseExclusive(owner, leaseId)) retryRelease(owner, leaseId, everyMs, left - 1);
  }, everyMs);
  timer.unref?.();
}

/**
 * Ротация `beats.log`: одним переименованием в `beats.1.log` (старое поколение заменяется тем же
 * шагом), следующий удар открывает новый файл. Одна попытка без повтора: удар идёт из таймера,
 * и ждать сканер здесь — блокировать цикл событий ядра; не вышло — удар в старый файл, ротация
 * на следующем ударе (ревью M4). Копия + обнуление при отказе второго шага оставляли два файла
 * с одними и теми же ударами.
 */
function rotateBeats(dir: string): void {
  renamePath(join(dir, TASK_FILES.beats), join(dir, 'beats.1.log'), SINGLE_ATTEMPT);
}
