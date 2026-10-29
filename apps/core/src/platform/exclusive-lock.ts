import { createHash } from 'node:crypto';
import { statSync, unlinkSync } from 'node:fs';
import type { Fact } from './os-kind.ts';
import { writeFileAtomic } from './safe-io/atomic-write.ts';
import { createExclusive, readBytesSync } from './safe-io/files.ts';

/**
 * Исключительный файл с перехватом у мёртвого держателя (01 §Lease, R:S2-22). Основа аренды
 * задачи и замка `procs.json`.
 *
 * Захват свободного — `wx` (единственная условная операция ФС). Перехват устаревшего — НЕ
 * `rename(owner → stale)`: переименование безусловно, и претендент, прочитавший устаревшего
 * держателя X, мог бы унести уже свежий файл Y другого победителя (две записи разом). Вместо
 * этого претендент занимает `wx`-заявку, имя которой выведено из держателя X
 * (`<file>.<X>.claim-<n>`): заявку на X получает ровно один, только он заменяет файл атомарно.
 * Мёртвый победитель заявки не запирает файл навсегда: следующая заявка `claim-<n+1>`
 * разрешена, когда держатель заявки `n` мёртв. Расхождение со словами 01 (rename + wx) —
 * в отчёте как дельта спецификации; итог тот же: ровно один владелец (P55).
 */

export type Liveness = 'alive' | 'dead' | 'unknown';

export interface LockHolder {
  leaseId: string;
  pid: number;
  pidStart: string;
  bootId: string;
  build: string;
  acquiredAt: number;
}

export interface LockDeps {
  /** Жив ли процесс по pid + старту (платформа C, `process-identity`); `unknown` — не перехватываем. */
  isAlive(id: { pid: number; start: string }): Promise<Liveness>;
  /** Молчит ли держатель достаточно долго (удары сердца аренды, возраст замка). */
  isSilent(holder: LockHolder | undefined, fileAgeMs: number): Promise<boolean> | boolean;
  now(): number;
  /**
   * Свой же брошенный файл (тот же процесс, ни одна живая аренда процесса его не держит) —
   * устаревший сразу. Только аренда задачи: замок `procs.json` берут параллельно в одном
   * процессе, там «свой» не значит «брошенный».
   */
  isOwnLeftover?(holder: LockHolder): boolean;
}

export type AcquireOutcome =
  | { acquired: true; takeoverOf: string | null }
  | { acquired: false; holder: LockHolder | undefined; reason: string };

function parseHolder(bytes: Buffer): LockHolder | undefined {
  try {
    const parsed = JSON.parse(bytes.toString('utf8')) as Partial<LockHolder>;
    if (
      typeof parsed.leaseId !== 'string' ||
      typeof parsed.pid !== 'number' ||
      typeof parsed.pidStart !== 'string'
    ) {
      return undefined;
    }
    return parsed as LockHolder;
  } catch {
    // Негодное содержимое — держатель не доказан; решает возраст файла, а не «нет файла».
    return undefined;
  }
}

export interface HolderRead {
  holder: LockHolder | undefined;
  key: string;
  ageMs: number;
  now: number;
}

/**
 * Держатель файла как факт: `absent` — файла нет (отпущен), `unknown` — файл есть, но не
 * прочитан (EACCES, EBUSY антивируса). Это не одно и то же: «нет файла» разрешает захват,
 * «не прочитан» — нет (F25), поэтому каждый вызывающий разбирает оба исхода сам.
 */
export function readHolder(path: string): Fact<HolderRead> {
  const bytes = readBytesSync(path);
  if (!('value' in bytes)) return bytes;
  const stats = statSync(path, { throwIfNoEntry: false });
  const holder = parseHolder(bytes.value);
  // Ключ заявки: id аренды держателя, а у негодного файла — отпечаток содержимого.
  const key =
    holder?.leaseId ?? `raw-${createHash('sha256').update(bytes.value).digest('hex').slice(0, 16)}`;
  const now = Date.now();
  return { value: { holder, key, ageMs: stats ? now - stats.mtimeMs : 0, now } };
}

async function holderIsStale(
  holder: LockHolder | undefined,
  ageMs: number,
  deps: LockDeps,
): Promise<boolean> {
  if (holder && deps.isOwnLeftover?.(holder)) return true;
  if (!(await deps.isSilent(holder, ageMs))) return false;
  if (!holder) return true;
  return (await deps.isAlive({ pid: holder.pid, start: holder.pidStart })) === 'dead';
}

const MAX_CLAIMS = 64;

/** Заявки `from..to` на держателя `key` (F-113); неудача удаления — не отказ захвата. */
function dropClaims(path: string, key: string, from: number, to: number): void {
  for (let n = from; n <= to; n += 1) {
    try {
      unlinkSync(`${path}.${key}.claim-${n}`);
    } catch {
      // Нет файла или занят — останется; следующий перехват X не случится (X уже не держатель).
    }
  }
}

export async function acquireExclusive(
  path: string,
  me: LockHolder,
  deps: LockDeps,
): Promise<AcquireOutcome> {
  if (createExclusive(path, JSON.stringify(me)) === 'created')
    return { acquired: true, takeoverOf: null };
  const read = readHolder(path);
  if ('unknown' in read) {
    // Файл есть, но не прочитан: держатель не доказан ни живым, ни мёртвым — не захватываем.
    return { acquired: false, holder: undefined, reason: `holder unreadable: ${read.unknown}` };
  }
  if ('absent' in read) {
    // Файл исчез между `wx` и чтением — его отпустили; одна повторная попытка захвата.
    if (createExclusive(path, JSON.stringify(me)) === 'created')
      return { acquired: true, takeoverOf: null };
    return { acquired: false, holder: undefined, reason: 'contended' };
  }
  const current = read.value;
  if (current.holder?.leaseId === me.leaseId) return { acquired: true, takeoverOf: null };
  if (!(await holderIsStale(current.holder, current.ageMs, deps))) {
    return { acquired: false, holder: current.holder, reason: 'held' };
  }
  for (let n = 1; n <= MAX_CLAIMS; n += 1) {
    const claim = `${path}.${current.key}.claim-${n}`;
    if (createExclusive(claim, JSON.stringify(me)) === 'created') {
      // Заявка на X наша. Файл всё ещё X? Сменить X могли лишь прежние победители заявок на X
      // (они мертвы — иначе мы бы сюда не дошли); если файл уже не X — не трогаем чужой.
      const again = readHolder(path);
      if ('unknown' in again) {
        dropClaims(path, current.key, n, n);
        return {
          acquired: false,
          holder: current.holder,
          reason: `holder unreadable during takeover: ${again.unknown}`,
        };
      }
      if ('absent' in again || again.value.key !== current.key) {
        dropClaims(path, current.key, n, n);
        return {
          acquired: false,
          holder: 'value' in again ? again.value.holder : undefined,
          reason: 'holder changed during takeover',
        };
      }
      writeFileAtomic(path, JSON.stringify(me));
      // Файл уже не X: заявки на X (свою и мёртвых соперников) больше никто не прочтёт как
      // действующие — убираем, иначе они копятся рядом с замком при каждом перехвате.
      dropClaims(path, current.key, 1, n);
      return { acquired: true, takeoverOf: current.holder?.leaseId ?? null };
    }
    const rival = readHolder(claim);
    if ('unknown' in rival) {
      return {
        acquired: false,
        holder: current.holder,
        reason: `takeover claim unreadable: ${rival.unknown}`,
      };
    }
    const rivalHolder = 'value' in rival ? rival.value.holder : undefined;
    if (!rivalHolder)
      return { acquired: false, holder: current.holder, reason: 'takeover claim unreadable' };
    const rivalLive = await deps.isAlive({ pid: rivalHolder.pid, start: rivalHolder.pidStart });
    if (rivalLive !== 'dead')
      return { acquired: false, holder: rivalHolder, reason: 'takeover in progress' };
  }
  return { acquired: false, holder: current.holder, reason: 'too many dead claims' };
}

/** Владеет ли `leaseId` файлом сейчас — как факт: `unknown`, если файл не прочитан. */
export function ownsExclusive(path: string, leaseId: string): Fact<boolean> {
  const read = readHolder(path);
  if ('value' in read) return { value: read.value.holder?.leaseId === leaseId };
  if ('absent' in read) return { value: false };
  return read;
}

/**
 * Самопроверка владельца на каждом ударе сердца. Непрочитанный файл — НЕ «владею»: владение
 * не доказано, а писать под недоказанной арендой нельзя (вторая запись в журнал хуже паузы);
 * следующий удар прочтёт файл снова.
 */
export function holdsExclusive(path: string, leaseId: string): boolean {
  const owns = ownsExclusive(path, leaseId);
  return 'value' in owns && owns.value;
}

/**
 * Отпустить: удаляется только свой файл; непрочитанный не трогаем — может быть чужим.
 * Неудача удаления (EBUSY антивируса, EPERM) — `false`, не исключение (F-113): вызывают из
 * `finally`, и брошенное там затёрло бы настоящую ошибку правки; файл остаётся своим и
 * уйдёт следующим отпусканием или перехватом.
 */
export function releaseExclusive(
  path: string,
  leaseId: string,
  unlink: (path: string) => void = unlinkSync,
): boolean {
  if (!holdsExclusive(path, leaseId)) return false;
  try {
    unlink(path);
    return true;
  } catch {
    return false;
  }
}
