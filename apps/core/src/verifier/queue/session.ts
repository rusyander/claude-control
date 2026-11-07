import { join } from 'node:path';
import type { QueueConfig, SessionTicket } from '@agentdeck/contracts/core/records';
import {
  acquireExclusive,
  releaseExclusive,
  type LockHolder,
} from '../../platform/exclusive-lock.ts';
import { factReason, type Fact } from '../../platform/os-kind.ts';
import { writeFileAtomic } from '../../platform/safe-io/atomic-write.ts';
import { ensureDir, listDir, readBytesSync } from '../../platform/safe-io/files.ts';
import { removeVerified } from '../../platform/safe-io/remove.ts';
import { holderKey, isSilent, MIN_BEAT_MS } from './order.ts';
import type { Liveness } from './queue.types.ts';
import type {
  SeatAcquire,
  SeatFile,
  SeatRequest,
  SessionQueue,
  SessionQueueDeps,
} from './session.types.ts';

/**
 * Места сеансов задач (этап 11, D9, P141-P142): одна аренда на сеанс модели, общая для всех ядер
 * и сборок машины (`<machine>/queue/session/`, вне любого дома ядра). Как у проверок —
 * файлы и исключительный замок выдачи, без демона; кому место — решает судья порядка работ
 * (`plan`, данный проводкой), здесь только диск, удары и устаревание.
 *
 * Устаревает место, только если молчит три удара И его держатель доказанно мёртв: держатель
 * выданного места с сеансом — хост сеанса, без сеанса и у ждущего билета — ядро. Смерть ядра
 * с живым хостом места не отдаёт (`silent-alive`, F25): сеанс идёт, его прикрепит следующее ядро.
 * Перезапущенное ядро берёт своё место (тот же шаг той же задачи) у доказанно мёртвого ядра;
 * чужие шаги никто не перенимает.
 */

const SUB = 'session';

function parseSeat(bytes: Buffer): SeatFile | undefined {
  try {
    const v = JSON.parse(bytes.toString('utf8')) as Partial<SeatFile> | null;
    return v && typeof v === 'object' && v.ticket && v.core && typeof v.beatAt === 'number'
      ? (v as SeatFile)
      : undefined;
  } catch {
    // Негодный файл — не «нет»: читающий называет его `unknown`.
    return undefined;
  }
}

const bound = (s: SeatFile): boolean => s.ticket.holder?.sessionId != null;
const held = (s: SeatFile): boolean => s.ticket.holder !== null;

/** Чью живость судить у молчащего места: хоста — если сеанс открыт, иначе ядра. */
export function judgeOf(s: SeatFile): { pid: number; start: string } {
  return bound(s) ? s.ticket.holder! : s.core;
}

/**
 * Все, чья доказанная смерть возвращает место: у открытого сеанса — хост И его CLI (личность
 * известна). Хост умер — CLI не обязан: на POSIX он в своей группе (`ownGroup`), сирота доделывает
 * ход, пока наблюдатель не снимет дерево (замер: CLI жил 1,4 с после выдачи места ждущему — пять
 * живых сеансов при четырёх местах). Без сеанса — ядро-владелец.
 */
export function judgesOf(s: SeatFile): { pid: number; start: string }[] {
  if (!bound(s)) return [s.core];
  const { pid, start, cli } = s.ticket.holder!;
  return cli ? [{ pid, start }, cli] : [{ pid, start }];
}

const allDead = (
  judges: readonly { pid: number; start: string }[],
  liveness: Readonly<Record<string, Liveness>>,
): boolean => judges.every((j) => liveness[`${j.pid}:${j.start}`] === 'dead');

/**
 * Устаревшие и молчащие живые (чистая часть, P142): молчит три удара и доказанно мертвы все судьи
 * (`judgesOf`) — снимается; живость `unknown` — не «мёртв».
 */
export function staleSeats(
  seats: readonly SeatFile[],
  now: number,
  beatMs: number,
  liveness: Readonly<Record<string, Liveness>>,
): { stale: string[]; silentAlive: string[] } {
  const out = { stale: [] as string[], silentAlive: [] as string[] };
  for (const s of seats) {
    if (!isSilent(s.beatAt, now, beatMs)) continue;
    if (allDead(judgesOf(s), liveness)) out.stale.push(s.ticket.ticketId);
    else out.silentAlive.push(s.ticket.ticketId);
  }
  return out;
}

/** За кем ждёт: самое старое место того же маршрута, иначе самое старое место вообще. */
export function holderFor(seat: SeatFile, live: readonly SeatFile[]): SeatFile | null {
  const counted = live
    .filter((s) => held(s) && !s.interactive && s.ticket.ticketId !== seat.ticket.ticketId)
    .sort((a, b) => (a.grantedAt ?? 0) - (b.grantedAt ?? 0));
  return counted.find((s) => s.routeId === seat.routeId) ?? counted[0] ?? null;
}

/** Каталог мест очереди машины `<queue>/session/seats`. */
export const seatsDirOf = (queueDir: string): string => join(queueDir, SUB, 'seats');

/**
 * Все места машины с диска — и для `GET /v1/allocator` ядра, ещё не бравшего места. Негодный
 * файл — `unknown`, а не «нет места».
 */
export function readSeats(seatsDir: string): Fact<SeatFile[]> {
  const names = listDir(seatsDir);
  if ('absent' in names) return { value: [] };
  if ('unknown' in names) return names;
  const out: SeatFile[] = [];
  for (const name of names.value) {
    if (name.startsWith('.') || !name.endsWith('.json')) continue;
    const bytes = readBytesSync(join(seatsDir, name));
    if ('absent' in bytes) continue; // снят между чтением каталога и файла
    if ('unknown' in bytes) return { unknown: `${name}: ${bytes.unknown}` };
    const seat = parseSeat(bytes.value);
    if (!seat) return { unknown: `${name}: garbage` };
    out.push(seat);
  }
  return { value: out };
}

export function createSessionQueue(deps: SessionQueueDeps): SessionQueue {
  const root = join(deps.dir, SUB);
  const seatsDir = seatsDirOf(deps.dir);
  ensureDir(seatsDir);
  const grantLock = join(root, '.grant.lock');
  const seatPath = (id: string): string => join(seatsDir, `${id}.json`);
  const configNow = (): QueueConfig => {
    const c = deps.config();
    return c.beatMs >= MIN_BEAT_MS ? c : { ...c, beatMs: MIN_BEAT_MS };
  };
  const mine = (s: SeatFile): boolean =>
    s.core.pid === deps.core.pid && s.core.start === deps.core.start;
  const write = (s: SeatFile): string | null => {
    try {
      writeFileAtomic(seatPath(s.ticket.ticketId), JSON.stringify(s));
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };

  const view = (): Fact<SeatFile[]> => readSeats(seatsDir);
  /** Своё место по билету с диска; нет файла или он негоден — `undefined`. */
  const readSeat = (ticketId: string): SeatFile | undefined => {
    const bytes = readBytesSync(seatPath(ticketId));
    const seat = 'value' in bytes ? parseSeat(bytes.value) : undefined;
    return seat && mine(seat) ? seat : undefined;
  };

  async function livenessOf(
    seats: readonly SeatFile[],
    now: number,
    beatMs: number,
    also: readonly SeatFile[] = [],
  ): Promise<Record<string, Liveness>> {
    const out: Record<string, Liveness> = {};
    const ask = async (id: { pid: number; start: string }): Promise<void> => {
      const k = `${id.pid}:${id.start}`;
      if (!(k in out)) out[k] = await deps.isAlive(id);
    };
    for (const s of seats)
      if (isSilent(s.beatAt, now, beatMs)) for (const j of judgesOf(s)) await ask(j);
    // Ядро чужого места своего шага: перенимать можно только у доказанно мёртвого.
    for (const s of also) await ask(s.core);
    return out;
  }

  async function underGrantLock<T>(
    body: () => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
    const config = configNow();
    const lockId = deps.newId();
    const me: LockHolder = {
      leaseId: lockId,
      pid: deps.core.pid,
      pidStart: deps.core.start,
      bootId: deps.core.bootId,
      build: deps.build,
      acquiredAt: deps.now(),
    };
    const got = await acquireExclusive(grantLock, me, {
      isAlive: deps.isAlive,
      isSilent: (_h, ageMs) => ageMs > 3 * config.beatMs,
      now: deps.now,
    });
    if (!got.acquired) {
      deps.onEvent?.({ kind: 'seat.grant-lock', reason: got.reason });
      return { ok: false, reason: got.reason };
    }
    try {
      return { ok: true, value: await body() };
    } finally {
      releaseExclusive(grantLock, lockId);
    }
  }

  function reap(seats: readonly SeatFile[], ids: { stale: string[]; silentAlive: string[] }) {
    const now = deps.now();
    for (const s of seats) {
      const id = s.ticket.ticketId;
      const base = { ticketId: id, taskId: s.ticket.taskId, holderPid: judgeOf(s).pid };
      if (ids.stale.includes(id)) {
        // Вид прочитан до проб живости: место могли отпустить (конец сеанса) или отбить, пока шла
        // проба. Отсутствующий путь `removeVerified` зовёт удалённым — отпущенное назвалось бы
        // снятым второй раз; поэтому снимается только то место, что лежит на диске таким же.
        const bytes = readBytesSync(seatPath(id));
        const onDisk = 'value' in bytes ? parseSeat(bytes.value) : undefined;
        if (!onDisk || onDisk.beatAt !== s.beatAt) continue;
        if (!removeVerified(seatPath(id)).removed) continue;
        deps.onEvent?.({ kind: 'seat.reaped', ...base, silentMs: now - s.beatAt });
      } else if (ids.silentAlive.includes(id))
        deps.onEvent?.({ kind: 'seat.silent-alive', ...base });
    }
  }

  const findStep = (seats: readonly SeatFile[], taskId: string, stepId: string) =>
    seats.find((s) => s.ticket.taskId === taskId && s.stepId === stepId);

  /** Просьба шага на диске: билет (прежний или новый) с полями просьбы, ещё без держателя. */
  function askedSeat(req: SeatRequest, was: SessionTicket | undefined, now: number): SeatFile {
    const ticket: SessionTicket = was ?? {
      ticketId: deps.newId(),
      kind: 'session',
      class: req.cls,
      project: req.project,
      taskId: req.taskId,
      key: null,
      enqueuedAt: now,
      build: deps.build,
      started: req.started,
      remainingMs: req.remainingMs,
      learnedMs: req.learnedMs,
      waitingSince: now,
      holder: null,
    };
    return {
      ticket: {
        ...ticket,
        started: req.started,
        remainingMs: req.remainingMs,
        learnedMs: req.learnedMs,
      },
      stepId: req.stepId,
      unitId: req.unitId,
      stepKind: req.stepKind,
      routeId: req.routeId,
      routeCap: req.routeCap,
      limit: req.limit,
      interactive: req.interactive,
      core: deps.core,
      beatAt: now,
      grantedAt: null,
      reason: null,
    };
  }

  /**
   * Чат не ждёт никогда (P141): он вне счёта мест, и ни судья, ни замок выдачи ему не нужны —
   * файл места только показывает сеанс распределителю. Под замком чат ждал бы чужую просьбу
   * (проба живости под ним — секунды на занятой машине). Тот же шаг — тот же билет и держатель.
   */
  function chatSeat(req: SeatRequest): SeatAcquire {
    const now = deps.now();
    const v = view();
    const was = 'value' in v ? findStep(v.value, req.taskId, req.stepId) : undefined;
    const kept = was && mine(was) && held(was) ? was.ticket.holder : null;
    const asked = askedSeat(req, was?.ticket, now);
    const granted: SeatFile = {
      ...asked,
      ticket: {
        ...asked.ticket,
        holder: kept ?? { pid: deps.core.pid, start: deps.core.start, sessionId: null },
      },
      grantedAt: was?.grantedAt ?? now,
    };
    // Не записалось — чат всё равно идёт: место его только видно, счёта оно не держит.
    write(granted);
    return { granted, detail: null };
  }

  return {
    beatMs: () => configNow().beatMs,

    async acquire(req) {
      if (req.interactive) return chatSeat(req);
      const config = configNow();
      const outcome = await underGrantLock(async (): Promise<SeatAcquire> => {
        const now = deps.now();
        const v = view();
        if (!('value' in v))
          return {
            waiting: `unreadable: ${factReason(v)}`,
            ticketId: null,
            holder: null,
            detail: null,
          };
        const existing = findStep(v.value, req.taskId, req.stepId);
        const foreign = existing && !mine(existing) ? [existing] : [];
        const liveness = await livenessOf(v.value, now, config.beatMs, foreign);
        const gone = staleSeats(v.value, now, config.beatMs, liveness);
        reap(v.value, gone);
        const live = v.value.filter((s) => !gone.stale.includes(s.ticket.ticketId));
        let seat = existing && live.includes(existing) ? existing : undefined;
        if (seat && !mine(seat)) {
          // Свой шаг у чужого ядра: перенимаем только у доказанно мёртвого (перезапуск ядра).
          if (liveness[holderKey(seat.core)] !== 'dead')
            return {
              waiting: 'held by a live core',
              ticketId: seat.ticket.ticketId,
              holder: seat,
              detail: null,
            };
          deps.onEvent?.({
            kind: 'seat.adopted',
            ticketId: seat.ticket.ticketId,
            taskId: req.taskId,
            fromPid: seat.core.pid,
          });
          seat = { ...seat, core: deps.core, beatAt: now };
        }
        if (seat && held(seat)) {
          const kept = { ...seat, beatAt: now, reason: null };
          write(kept);
          return { granted: kept, detail: null };
        }
        const asked = askedSeat(req, seat?.ticket, now);
        const ticket = asked.ticket;
        const others = live.filter((s) => s.ticket.ticketId !== ticket.ticketId);
        const heldNow = others.filter((s) => held(s) && !s.interactive);
        const waiting = [...others.filter((s) => !held(s) && !s.interactive), asked];
        const plan = deps.plan({ waiting, held: heldNow, now, config });
        if (plan.grant.includes(ticket.ticketId)) {
          const granted: SeatFile = {
            ...asked,
            ticket: {
              ...asked.ticket,
              holder: { pid: deps.core.pid, start: deps.core.start, sessionId: null },
            },
            grantedAt: now,
          };
          const failed = write(granted);
          if (failed === null) return { granted, detail: plan.detail };
          return {
            waiting: `unwritable: ${failed}`,
            ticketId: null,
            holder: null,
            detail: plan.detail,
          };
        }
        const why = plan.blocked[ticket.ticketId] ?? 'slot';
        const waiter = { ...asked, reason: why };
        write(waiter);
        return {
          waiting: why,
          ticketId: ticket.ticketId,
          holder: holderFor(waiter, others),
          detail: plan.detail,
        };
      });
      return outcome.ok
        ? outcome.value
        : { waiting: `contended: ${outcome.reason}`, ticketId: null, holder: null, detail: null };
    },

    bind(taskId, stepId, host) {
      const v = view();
      if (!('value' in v)) return false;
      const seat = findStep(v.value, taskId, stepId);
      if (!seat || !mine(seat) || !held(seat)) return false;
      return write({ ...seat, ticket: { ...seat.ticket, holder: { ...host } } }) === null;
    },

    release(taskId, stepId) {
      const v = view();
      if (!('value' in v)) return false;
      const seat = findStep(v.value, taskId, stepId);
      // Чужое место (ядро живо или ещё не перенято) не трогаем; снятое уже — нечего отпускать.
      if (!seat || !mine(seat)) return false;
      return removeVerified(seatPath(seat.ticket.ticketId)).removed;
    },

    async beat() {
      const v = view();
      if (!('value' in v)) return { fingerprint: `?${factReason(v)}`, hostDead: [] };
      const hostDead: string[] = [];
      const gone = new Set<string>();
      const now = deps.now();
      const { beatMs } = configNow();
      for (const s of v.value.filter(mine)) {
        if (bound(s) && (await deps.isAlive(s.ticket.holder!)) === 'dead') {
          // Хост сеанса доказанно мёртв: место не бьётся и вернётся через три удара (P142). Снимает
          // его само ядро-владелец: ждущие других ядер будятся сменой набора держащих, а без
          // снятия набор не менялся бы и никто не попросил бы места снова. Пережившего хост CLI
          // (`judgesOf`) место ждёт: его дерево снимает наблюдатель, следующий удар снимет место.
          hostDead.push(s.ticket.ticketId);
          const cli = s.ticket.holder!.cli;
          if (isSilent(s.beatAt, now, beatMs) && (!cli || (await deps.isAlive(cli)) === 'dead')) {
            reap([s], { stale: [s.ticket.ticketId], silentAlive: [] });
            gone.add(s.ticket.ticketId);
          }
          continue;
        }
        // Пока шла проба живости, место могли отпустить или прикрепить: удар пишет только то,
        // что лежит на диске сейчас (чтение и запись синхронны — `release` между ними не встанет),
        // иначе отпущенное место воскресло бы держащим.
        const current = readSeat(s.ticket.ticketId);
        if (current) write({ ...current, beatAt: now });
      }
      // Чужое место, ставшее устаревшим (молчит три удара, судья доказанно мёртв: ядро без
      // сеанса, хост с сеансом), снимает только просьба под замком выдачи. Отпечаток метит его —
      // иначе набор держащих не менялся бы, ждущие спали бы, а место мёртвого ядра (и его ждущий
      // билет во главе очереди) держало бы машину, пока кто-то случайно не попросит места.
      const silent = v.value.filter(
        (s) => !mine(s) && !gone.has(s.ticket.ticketId) && isSilent(s.beatAt, now, beatMs),
      );
      const liveness = await livenessOf(silent, now, beatMs);
      const reapable = staleSeats(silent, now, beatMs, liveness).stale.map((id) => `!${id}`);
      const fingerprint = [
        ...v.value
          .filter((s) => held(s) && !gone.has(s.ticket.ticketId))
          .map((s) => s.ticket.ticketId),
        ...reapable,
      ]
        .sort()
        .join(',');
      return { fingerprint, hostDead };
    },

    view,
  };
}
