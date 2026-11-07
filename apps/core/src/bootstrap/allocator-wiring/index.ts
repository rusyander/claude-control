import type { AllocatorPort } from '../../api/allocator.ts';
import type { SessionOccupancy } from '../../conductor/estimate/index.ts';
import { stepClassOf, type SeatAnswer, type SeatPort } from '../../conductor/schedule/index.ts';
import type { TaskRegistry } from '../../conductor/tasks.ts';
import { WindowBook } from '../../economy/window/index.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { readCoreConfig } from '../../platform/core-config/read.ts';
import type { CoreHomeLayout } from '../../platform/core-home.ts';
import type { Fact } from '../../platform/os-kind.ts';
import { createLivenessProbe, identityOfPid } from '../../platform/process-identity.ts';
import type { RouteRegistry } from '../../routes/registry.ts';
import { queueConfigReader } from '../../verifier/queue/config.ts';
import { DEFAULT_QUEUE_CONFIG } from '../../verifier/queue/order.ts';
import type { Liveness } from '../../verifier/queue/queue.types.ts';
import { createSessionQueue, readSeats, seatsDirOf } from '../../verifier/queue/session.ts';
import type { SeatAcquire, SeatRequest, SessionQueue } from '../../verifier/queue/session.types.ts';
import { coreBuild } from '../verifier-wiring/queue.ts';
import { machineQueueDir, windowFactStore } from './machine.ts';
import {
  allocatorView,
  occupancyOf,
  parallelismOf,
  seatPlanner,
  sessionSlotsOf,
} from './planner.ts';

/**
 * Проводка распределителя мест сеансов (этап 11, D9, P141-P142) — вход загрузки: книга окон ядра
 * с общим хранилищем фактов машины (`<machine>/queue/window/`, `economy/window` остаётся чистой),
 * очередь мест сеансов машины (`<machine>/queue/session/`), порт мест исполнителю и порт
 * `/v1/allocator`. Каталог машины — `machine.ts`.
 *
 * Очередь собирается при первой просьбе места (личность процесса ядра читается из таблицы ОС).
 * Удар — каждые `beatMs`: свои места бьются, сменился набор держащих по машине — исполнители
 * будятся (место освободилось у другого ядра); своё освобождение будит сразу.
 */

export interface AllocatorWiringDeps {
  layout: CoreHomeLayout;
  note: (event: string, data: Record<string, unknown>) => void;
  /** Ячейки: реестры задач и маршрутов собираются позже книги окон. */
  registry: () => TaskRegistry | undefined;
  routes: () => RouteRegistry;
  /** Каталог очереди машины; нет — `machineQueueDir` (переменная, дом, `~/.agentdeck/machine`). */
  queueDir?: string;
  /** Внешние границы для тестов: часы и живость процессов. */
  now?: () => number;
  isAlive?: (id: { pid: number; start: string }) => Promise<Liveness>;
}

/** Что дирижёр берёт у распределителя: места шагов и действующую параллельность задачи. */
export interface ConductorAllocator {
  seats: SeatPort;
  /** min(профиль задачи, `queue.sessionSlots`); без задачи — умолчание машины. */
  parallelism(task?: LiveTask): number;
  /** Держащие и ждущие места по файлам мест машины (ожидание места на оценке, W3-16). */
  occupancy(): Fact<SessionOccupancy>;
}

export interface AllocatorWiring {
  /** Фабрика книги окон (G7): ОДНА книга на ядро — её пишет экономика, читают судьи и health. */
  windowBook(): WindowBook;
  port(): AllocatorPort | undefined;
  conductor(): ConductorAllocator;
  stop(): Promise<void>;
}

const reasonOf = (f: Fact<unknown>): string => ('unknown' in f ? f.unknown : 'absent');

/** Повторы просьбы при занятом замке выдачи: пауза растёт с попыткой (25, 50 … мс). */
const CONTENDED_TRIES = 8;
const CONTENDED_PAUSE_MS = 25;

export function createAllocatorWiring(deps: AllocatorWiringDeps): AllocatorWiring {
  const queueDir = deps.queueDir ?? machineQueueDir(deps.layout);
  const config = queueConfigReader(deps.layout.config, DEFAULT_QUEUE_CONFIG, (issue) =>
    deps.note('allocator.config', { issue }),
  );
  const now = deps.now ?? Date.now;
  const probe = deps.isAlive ? null : createLivenessProbe();
  const isAlive = deps.isAlive ?? ((id) => probe!.isAlive(id));
  let book: WindowBook | undefined;
  let queue: Promise<SessionQueue> | undefined;
  let built: SessionQueue | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  let fingerprint = '';
  const wakers = new Set<() => void>();
  /** Сеанс открыт, а строка `session.started` ещё не свёрнута: прикрепить на следующем ударе. */
  const binds = new Map<string, { taskId: string; stepId: string; sessionId: string }>();

  const wakeAll = (): void => {
    for (const w of [...wakers]) w();
  };
  const leadSection = () => {
    const read = readCoreConfig(deps.layout);
    return 'value' in read ? read.value.doc.lead : undefined;
  };
  const parallelism = (task?: LiveTask): number =>
    parallelismOf(leadSection(), task?.state, sessionSlotsOf(config()));

  const tryBind = (q: SessionQueue, b: { taskId: string; stepId: string; sessionId: string }) => {
    const rec = deps.registry()?.live(b.taskId)?.state.sessions[b.sessionId];
    if (!rec) return false;
    // CLI — второй судья места: пережив хост, он ещё работает, и место ему (`judgesOf`).
    const cli =
      rec.cliPid !== null && rec.cliStart !== null
        ? { pid: rec.cliPid, start: rec.cliStart }
        : null;
    q.bind(b.taskId, b.stepId, {
      pid: rec.hostPid,
      start: rec.hostStart,
      sessionId: b.sessionId,
      cli,
    });
    return true;
  };

  /** Удар в полёте: проба живости бывает дольше такта — следующий удар его не обгоняет. */
  let beating = false;
  const beat = async (q: SessionQueue): Promise<void> => {
    if (beating) return;
    beating = true;
    try {
      for (const [key, b] of binds) if (tryBind(q, b)) binds.delete(key);
      const got = await q.beat();
      for (const id of got.hostDead) deps.note('seat.host-dead', { ticketId: id });
      if (got.fingerprint !== fingerprint) {
        fingerprint = got.fingerprint;
        wakeAll();
      }
    } finally {
      beating = false;
    }
  };

  /**
   * Замок выдачи держит другое ядро — короткий повтор, а не ожидание освобождения: занятый замок
   * мест не меняет, и пробуждения за ним может не прийти вовсе.
   */
  const acquireOf = async (q: SessionQueue, req: SeatRequest): Promise<SeatAcquire> => {
    for (let attempt = 1; ; attempt += 1) {
      const got = await q.acquire(req);
      if (!('waiting' in got) || !got.waiting.startsWith('contended:')) return got;
      if (attempt >= CONTENDED_TRIES || stopped) {
        // Ждущий шаг будится через такт и просит снова.
        if (!stopped) setTimeout(wakeAll, q.beatMs()).unref?.();
        return got;
      }
      await new Promise((r) => setTimeout(r, CONTENDED_PAUSE_MS * attempt));
    }
  };

  const queueOf = (): Promise<SessionQueue> =>
    (queue ??= (async () => {
      const me = await identityOfPid(process.pid);
      if (!('value' in me)) throw new Error(`own process identity: ${reasonOf(me)}`);
      const q = createSessionQueue({
        dir: queueDir,
        config,
        core: { pid: process.pid, start: me.value.start, bootId: newId() },
        build: coreBuild(),
        now,
        newId,
        isAlive,
        plan: seatPlanner,
        onEvent: (event) => deps.note(event.kind, { ...event }),
      });
      built = q;
      if (!stopped) {
        timer = setInterval(() => {
          void beat(q).catch((error: unknown) =>
            deps.note('allocator.beat-failed', { error: String(error) }),
          );
        }, q.beatMs());
        timer.unref?.();
      }
      return q;
    })());

  const seats: SeatPort = {
    async acquire(ask): Promise<SeatAnswer> {
      let q: SessionQueue;
      try {
        q = await queueOf();
      } catch (error) {
        // Личность ядра не прочлась: шаг ждёт (место не выдаётся вслепую), следующая просьба
        // собирает очередь заново.
        queue = undefined;
        const reason = `allocator unavailable: ${String(error)}`;
        return { granted: false, ticketId: null, reason, holder: null, decision: null };
      }
      const state = deps.registry()?.live(ask.taskId)?.state;
      const got = await acquireOf(q, {
        taskId: ask.taskId,
        stepId: ask.stepId,
        unitId: ask.unitId,
        stepKind: ask.stepKind,
        cls: stepClassOf(ask.stepKind),
        project: state?.created?.repos[0]?.repoKey ?? 'unknown',
        routeId: ask.routeId,
        // Ёмкость — свойство маршрута в реестре (P108: маршрут не называется по id).
        routeCap: deps.routes().get(ask.routeId)?.caps.sessionCap ?? null,
        limit: parallelismOf(leadSection(), state, sessionSlotsOf(config())),
        interactive: ask.interactive,
        started: ask.started,
        remainingMs: ask.remainingMs,
        learnedMs: ask.learnedMs,
      });
      const decision = (got.detail ?? null) as never;
      if ('granted' in got)
        return { granted: true, ticketId: got.granted.ticket.ticketId, decision };
      return {
        granted: false,
        ticketId: got.ticketId,
        reason: got.waiting,
        holder: got.holder
          ? {
              taskId: got.holder.ticket.taskId,
              sessionId: got.holder.ticket.holder?.sessionId ?? null,
            }
          : null,
        decision,
      };
    },
    bind(taskId, stepId, sessionId) {
      if (!built) return;
      const b = { taskId, stepId, sessionId };
      if (!tryBind(built, b)) binds.set(`${taskId}:${stepId}`, b);
    },
    release(taskId, stepId, why) {
      binds.delete(`${taskId}:${stepId}`);
      if (!built || !built.release(taskId, stepId)) return;
      deps.note('seat.released', { taskId, stepId, why });
      wakeAll();
    },
    subscribe(wake) {
      wakers.add(wake);
      return () => wakers.delete(wake);
    },
  };

  const capacityNow = () => ({
    parallelism: parallelism(),
    sessionSlots: sessionSlotsOf(config()),
  });
  // Нечитаемые места — `unknown` с причиной: ожидание не оценивается, а не «свободно».
  const occupancy = (): Fact<SessionOccupancy> => {
    const all = readSeats(seatsDirOf(queueDir));
    return 'value' in all ? { value: occupancyOf(allocatorView(all.value, capacityNow())) } : all;
  };

  return {
    windowBook: () => (book ??= new WindowBook(windowFactStore(queueDir))),
    port: () => ({
      view: () => {
        // С диска, а не из своей очереди: ядро, ещё не бравшее места, видит места соседей.
        const all = readSeats(seatsDirOf(queueDir));
        return allocatorView('value' in all ? all.value : [], capacityNow());
      },
    }),
    conductor: () => ({ seats, parallelism, occupancy }),
    stop: async () => {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      wakers.clear();
    },
  };
}
