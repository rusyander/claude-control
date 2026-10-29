import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { QueueConfig, QueueLease, QueueTicket } from '@agentdeck/contracts/core/records';
import {
  acquireExclusive,
  readHolder,
  releaseExclusive,
  type LockDeps,
  type LockHolder,
} from '../../platform/exclusive-lock.ts';
import { factReason, type Fact } from '../../platform/os-kind.ts';
import { writeFileAtomic } from '../../platform/safe-io/atomic-write.ts';
import { listDir, readBytesSync } from '../../platform/safe-io/files.ts';
import { removeVerified } from '../../platform/safe-io/remove.ts';
import { holderKey, isIdle, isSilent, MIN_BEAT_MS, planGrants } from './order.ts';
import type {
  AcquireAnswer,
  HeartbeatAnswer,
  InflightHold,
  Liveness,
  QueueEvent,
  QueueHolder,
  QueueView,
  WaitingTicket,
} from './queue.types.ts';

/**
 * Очередь проверок на диске (00:59-60 `<core home>/queue/`, D§3.8): общая для всех сборок
 * ядра и всех процессов машины — координация файлами, без демона. Билет ждёт в `tickets/`,
 * выданная аренда лежит в `leases/`, ключ «в полёте» — `inflight/`. Решение «кому слот»
 * принимает одна чистая модель (`order.ts`) под замком выдачи `.grant.lock` — замок
 * исключительный (`wx`, перехват у мёртвого), поэтому две сборки не выдадут один слот дважды.
 * Чужой файл, который не прочитался, — не «нет»: такой проход отвечает `unreadable` (F25).
 */

export interface CheckQueueDeps {
  /** `<core home>/queue` */
  dir: string;
  /** Раздел `queue` настройки — перечитывается на каждом проходе (D§3.8). */
  config(): QueueConfig;
  holder: QueueHolder;
  build: string;
  now(): number;
  newId(): string;
  isAlive(id: { pid: number; start: string }): Promise<Liveness>;
  /** `platform/machine` (зона E): мало свободной памяти — слоты новым выдачам ниже (04:116). */
  lowMemory?(): boolean;
  onEvent?(event: QueueEvent): void;
}

export interface CheckQueue {
  /** Такт удара держателя из настройки (перечитывается): молчит три такта — снимается. */
  beatMs(): number;
  enqueue(t: Omit<QueueTicket, 'ticketId' | 'enqueuedAt' | 'kind' | 'build'>): QueueTicket;
  acquire(ticketId: string): Promise<AcquireAnswer>;
  beatTicket(ticketId: string): HeartbeatAnswer;
  withdraw(ticketId: string): void;
  heartbeat(leaseId: string): HeartbeatAnswer;
  release(leaseId: string): boolean;
  idle(): Promise<Fact<boolean>>;
  view(): Fact<QueueView>;
  inflight(project: string, key: string): Fact<InflightHold | null>;
  claimInflight(
    project: string,
    key: string,
    checkRunId: string,
  ): Promise<{ claimed: true } | { claimed: false; hold: InflightHold | null; reason: string }>;
  beatInflight(project: string, key: string, checkRunId: string): HeartbeatAnswer;
  releaseInflight(project: string, key: string, checkRunId: string): boolean;
}

const SUB = 'check';

function parseJson<T>(bytes: Buffer, ok: (v: unknown) => boolean): T | undefined {
  try {
    const parsed = JSON.parse(bytes.toString('utf8')) as unknown;
    return ok(parsed) ? (parsed as T) : undefined;
  } catch {
    // Негодный файл — не «нет»: читающий называет его `unreadable`.
    return undefined;
  }
}

const isTicketFile = (v: unknown): boolean =>
  typeof v === 'object' && v !== null && 'ticket' in v && 'holder' in v && 'beatAt' in v;
const isLeaseFile = (v: unknown): boolean =>
  typeof v === 'object' && v !== null && 'leaseId' in v && 'ticket' in v && 'heartbeatAt' in v;

/** Атомарная запись без броска: `null` — записано, иначе причина отказа (EPERM, ENOSPC …). */
function tryWrite(path: string, text: string): string | null {
  try {
    writeFileAtomic(path, text);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Имя файла ключа: проект и ключ одним хешем — путь короткий и без знаков пути. */
export function flightFile(project: string, key: string): string {
  return createHash('sha256').update(`${project}\u0000${key}`).digest('hex').slice(0, 40);
}

export function createCheckQueue(deps: CheckQueueDeps): CheckQueue {
  const root = join(deps.dir, SUB);
  const ticketsDir = join(root, 'tickets');
  const leasesDir = join(root, 'leases');
  const flightDir = join(root, 'inflight');
  const grantLock = join(root, '.grant.lock');
  const ticketPath = (id: string): string => join(ticketsDir, `${id}.json`);
  const leasePath = (id: string): string => join(leasesDir, `${id}.json`);
  const flightPath = (project: string, key: string): string =>
    join(flightDir, `${flightFile(project, key)}.lock`);
  // Один такт для того, кто бьёт (`beatMs()`), и того, кто судит молчание: ниже пола не бывает.
  const configNow = (): QueueConfig => {
    const c = deps.config();
    return c.beatMs >= MIN_BEAT_MS ? c : { ...c, beatMs: MIN_BEAT_MS };
  };

  function readAll<T>(dir: string, ok: (v: unknown) => boolean): Fact<T[]> {
    const names = listDir(dir);
    if ('absent' in names) return { value: [] };
    if ('unknown' in names) return names;
    const out: T[] = [];
    for (const name of names.value) {
      // Временные файлы атомарной записи начинаются с точки — не билеты.
      if (name.startsWith('.') || !name.endsWith('.json')) continue;
      const bytes = readBytesSync(join(dir, name));
      if ('absent' in bytes) continue; // снят между чтением каталога и файла
      if ('unknown' in bytes) return { unknown: `${name}: ${bytes.unknown}` };
      const parsed = parseJson<T>(bytes.value, ok);
      if (!parsed) return { unknown: `${name}: garbage` };
      out.push(parsed);
    }
    return { value: out };
  }

  function view(): Fact<QueueView> {
    const tickets = readAll<WaitingTicket>(ticketsDir, isTicketFile);
    if (!('value' in tickets)) return tickets;
    const leases = readAll<QueueLease>(leasesDir, isLeaseFile);
    if (!('value' in leases)) return leases;
    return { value: { tickets: tickets.value, leases: leases.value } };
  }

  /** Живость спрашивается только у молчащих: остальные свежи по удару сердца. */
  async function livenessOf(
    v: QueueView,
    now: number,
    beatMs: number,
  ): Promise<Record<string, Liveness>> {
    const out: Record<string, Liveness> = {};
    const silent = [
      ...v.tickets.filter((t) => isSilent(t.beatAt, now, beatMs)).map((t) => t.holder),
      ...v.leases.filter((l) => isSilent(l.heartbeatAt, now, beatMs)).map((l) => l.holder),
    ];
    for (const h of silent) {
      const k = holderKey(h);
      if (!(k in out)) out[k] = await deps.isAlive({ pid: h.pid, start: h.start });
    }
    return out;
  }

  function lockDeps(beatMs: number): LockDeps {
    return {
      isAlive: deps.isAlive,
      // Замок выдачи держат миллисекунды: молчание трёх ударов — уже брошенный.
      isSilent: (_h, ageMs) => ageMs > 3 * beatMs,
      now: deps.now,
    };
  }

  function me(id: string): LockHolder {
    return {
      leaseId: id,
      pid: deps.holder.pid,
      pidStart: deps.holder.start,
      bootId: deps.holder.bootId,
      build: deps.build,
      acquiredAt: deps.now(),
    };
  }

  async function underGrantLock<T>(
    body: () => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
    const config = configNow();
    const lockId = deps.newId();
    const got = await acquireExclusive(grantLock, me(lockId), lockDeps(config.beatMs));
    if (!got.acquired) {
      deps.onEvent?.({ kind: 'grant-lock', reason: got.reason });
      return { ok: false, reason: got.reason };
    }
    try {
      return { ok: true, value: await body() };
    } finally {
      releaseExclusive(grantLock, lockId);
    }
  }

  function reap(plan: ReturnType<typeof planGrants>, v: QueueView, now: number): void {
    for (const id of plan.staleTickets) {
      const t = v.tickets.find((x) => x.ticket.ticketId === id);
      removeVerified(ticketPath(id));
      if (t)
        deps.onEvent?.({
          kind: 'reaped',
          what: 'ticket',
          id,
          holderPid: t.holder.pid,
          silentMs: now - t.beatAt,
        });
    }
    for (const id of plan.staleLeases) {
      const l = v.leases.find((x) => x.leaseId === id);
      removeVerified(leasePath(id));
      if (l)
        deps.onEvent?.({
          kind: 'reaped',
          what: 'lease',
          id,
          holderPid: l.holder.pid,
          silentMs: now - l.heartbeatAt,
        });
    }
    for (const id of plan.silentAlive) {
      const t = v.tickets.find((x) => x.ticket.ticketId === id);
      const l = v.leases.find((x) => x.leaseId === id);
      const holder = t?.holder ?? l?.holder;
      const beat = t?.beatAt ?? l?.heartbeatAt ?? now;
      if (holder)
        deps.onEvent?.({ kind: 'silent-alive', id, holderPid: holder.pid, silentMs: now - beat });
    }
  }

  function rewriteIfOurs<T>(
    path: string,
    ok: (v: unknown) => boolean,
    mine: (v: T) => boolean,
    update: (v: T) => T,
  ): HeartbeatAnswer {
    const bytes = readBytesSync(path);
    if ('absent' in bytes) return 'lost';
    if ('unknown' in bytes) return { unknown: bytes.unknown };
    const parsed = parseJson<T>(bytes.value, ok);
    if (!parsed) return { unknown: 'garbage' };
    if (!mine(parsed)) return 'lost';
    // Удар зовут голые таймеры (прогон, ожидание выдачи): брошенное отсюда роняло всё ядро.
    // Не записалось — не «отобрали»: следующий удар пишет снова, молчание решает очередь.
    const written = tryWrite(path, JSON.stringify(update(parsed)));
    return written === null ? 'ok' : { unknown: written };
  }

  const ownHolder = (h: QueueHolder): boolean =>
    h.pid === deps.holder.pid && h.start === deps.holder.start;

  return {
    beatMs: () => configNow().beatMs,

    enqueue(t) {
      const ticket: QueueTicket = {
        ...t,
        ticketId: deps.newId(),
        kind: 'check',
        build: deps.build,
        enqueuedAt: deps.now(),
      };
      const file: WaitingTicket = { ticket, holder: deps.holder, beatAt: ticket.enqueuedAt };
      writeFileAtomic(ticketPath(ticket.ticketId), JSON.stringify(file));
      return ticket;
    },

    async acquire(ticketId) {
      const config = configNow();
      const outcome = await underGrantLock(async (): Promise<AcquireAnswer> => {
        const now = deps.now();
        const v = view();
        if (!('value' in v)) return { waiting: 'unreadable', detail: factReason(v) };
        const plan = planGrants({
          view: v.value,
          now,
          config,
          liveness: await livenessOf(v.value, now, config.beatMs),
          lowMemory: deps.lowMemory?.() ?? false,
        });
        reap(plan, v.value, now);
        const mine = v.value.tickets.find((t) => t.ticket.ticketId === ticketId);
        if (!mine || plan.staleTickets.includes(ticketId))
          return { gone: 'ticket not in queue (reaped or withdrawn)' };
        if (!plan.grant.includes(ticketId)) {
          const why = plan.blocked[ticketId] ?? 'slot';
          return {
            waiting: why,
            detail: `${why}: ${plan.grant.length} granted this pass, slots ${plan.slots}`,
          };
        }
        // Выдаётся только свой билет: чужие ждут своего прохода (их держатель пишет аренду сам).
        const lease: QueueLease = {
          leaseId: deps.newId(),
          ticket: mine.ticket,
          holder: deps.holder,
          heartbeatAt: now,
          slots: plan.slots,
        };
        // Аренда не записалась — слот не выдан: билет остаётся и ждёт следующего прохода (брошенное
        // отсюда оставляло билет живого держателя навсегда, а выдача ставила его впереди всех).
        const failed = tryWrite(leasePath(lease.leaseId), JSON.stringify(lease));
        if (failed !== null) return { waiting: 'unwritable', detail: `lease write: ${failed}` };
        removeVerified(ticketPath(ticketId));
        return { granted: lease };
      });
      return outcome.ok ? outcome.value : { waiting: 'contended', detail: outcome.reason };
    },

    beatTicket(ticketId) {
      return rewriteIfOurs<WaitingTicket>(
        ticketPath(ticketId),
        isTicketFile,
        (t) => ownHolder(t.holder),
        (t) => ({ ...t, beatAt: deps.now() }),
      );
    },

    withdraw(ticketId) {
      removeVerified(ticketPath(ticketId));
    },

    heartbeat(leaseId) {
      return rewriteIfOurs<QueueLease>(
        leasePath(leaseId),
        isLeaseFile,
        (l) => ownHolder(l.holder),
        (l) => ({ ...l, heartbeatAt: deps.now() }),
      );
    },

    release(leaseId) {
      const bytes = readBytesSync(leasePath(leaseId));
      if (!('value' in bytes)) return false;
      const lease = parseJson<QueueLease>(bytes.value, isLeaseFile);
      // Чужую аренду (тот же id не у нас) не трогаем; снятая уже — нечего отпускать.
      if (!lease || !ownHolder(lease.holder)) return false;
      return removeVerified(leasePath(leaseId)).removed;
    },

    async idle() {
      const v = view();
      if (!('value' in v)) return v;
      const config = configNow();
      const now = deps.now();
      return {
        value: isIdle({
          view: v.value,
          now,
          config,
          liveness: await livenessOf(v.value, now, config.beatMs),
          lowMemory: deps.lowMemory?.() ?? false,
        }),
      };
    },

    view,

    inflight(project, key) {
      const read = readHolder(flightPath(project, key));
      if ('absent' in read) return { value: null };
      if ('unknown' in read) return read;
      const h = read.value.holder;
      if (!h) return { unknown: 'inflight lock: garbage' };
      // Молчащий держатель всё равно назван: решает ждущий (отбор у мёртвого — claimInflight).
      return { value: { checkRunId: h.leaseId, since: h.acquiredAt, pid: h.pid } };
    },

    async claimInflight(project, key, checkRunId) {
      const config = configNow();
      const path = flightPath(project, key);
      const got = await acquireExclusive(
        path,
        { ...me(checkRunId), acquiredAt: deps.now() },
        {
          isAlive: deps.isAlive,
          // Держатель ключа бьёт сердцем перезаписью файла: возраст файла = молчание.
          isSilent: (_h, ageMs) => ageMs > 3 * config.beatMs,
          now: deps.now,
        },
      );
      if (got.acquired) return { claimed: true };
      const h = got.holder;
      return {
        claimed: false,
        hold: h ? { checkRunId: h.leaseId, since: h.acquiredAt, pid: h.pid } : null,
        reason: got.reason,
      };
    },

    beatInflight(project, key, checkRunId) {
      return rewriteIfOurs<LockHolder>(
        flightPath(project, key),
        (v) => typeof v === 'object' && v !== null && 'leaseId' in v,
        (h) => h.leaseId === checkRunId,
        (h) => h,
      );
    },

    releaseInflight(project, key, checkRunId) {
      return releaseExclusive(flightPath(project, key), checkRunId);
    },
  };
}
