import {
  CORE_HOME_BUSY_EXIT,
  type CoreSupervisorStatus,
} from '@agentdeck/contracts/core/supervisor';
import type {
  CoreExit,
  CoreProbe,
  CoreSupervisor,
  CoreSupervisorDeps,
  CoreSupervisorTimers,
  SpawnedCore,
} from './core-supervisor.types.ts';

/**
 * Надзор панели за процессом ядра (этап 10): приложение — один продукт. Панель на старте
 * усыновляет живое ядро своего дома (`pnpm core`, автозапуск ОС, ядро прошлой панели) или
 * поднимает своё — отвязанным, в своей группе процессов, так что ядро переживает панель.
 * Ядро упало — подъём заново с отступом 1 → 60 с; пять неудач за десять минут — `fault`:
 * карточка сбоя с кодом выхода и хвостом журнала, дальше только кнопка «Перезапустить».
 *
 * Почему отступ и потолок: ядро, падающее на загрузке (битый `config.json`, занятый дом),
 * без них крутилось бы циклом, съедая процессор и засыпая журнал; человек узнал бы о сбое
 * из вентилятора. Потолок превращает цикл в состояние, которое видно и которое чинят.
 *
 * Своё ядро вышло на загрузке с кодом «дом занят» (`CORE_HOME_BUSY_EXIT`) — это не падение: другое
 * ядро (вторая панель, `pnpm core`, автозапуск) взяло замок дома раньше. Надзор снова сверяет дом и
 * усыновляет победителя; неудачей это станет, только если победитель не поднялся за срок подъёма.
 *
 * Сам модуль процессов не трогает: подъём, сверка, живость и снятие — зависимости
 * (`launch.ts`, `probe.ts`), тест гоняет машину состояний на поддельных часах.
 */

export const CORE_FAULT_WINDOW_MS = 10 * 60_000;
export const CORE_FAULT_FAILS = 5;
export const CORE_BACKOFF_MIN_MS = 1_000;
export const CORE_BACKOFF_MAX_MS = 60_000;
/** Столько прожило без падения — прошлые неудачи отступ больше не удлиняют. */
export const CORE_HEALTHY_MS = 60_000;
const READY_MS = 15_000;
const POLL_MS = 1_000;

/** Отступ перед `n`-й подряд попыткой: 1, 2, 4 … 60 с. */
export function coreBackoffMs(consecutive: number): number {
  return Math.min(CORE_BACKOFF_MAX_MS, CORE_BACKOFF_MIN_MS * 2 ** Math.max(0, consecutive - 1));
}

const REAL_TIMERS: CoreSupervisorTimers = {
  set: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref();
    return handle;
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function createCoreSupervisor(deps: CoreSupervisorDeps): CoreSupervisor {
  const timers = deps.timers ?? REAL_TIMERS;
  const readyMs = deps.readyMs ?? READY_MS;
  const pollMs = deps.pollMs ?? POLL_MS;
  let state: CoreSupervisorStatus['state'] = 'starting';
  let pid: number | null = null;
  let upSince = 0;
  let failures: number[] = [];
  let consecutive = 0;
  let lastExit: CoreSupervisorStatus['lastExit'] = null;
  let nextRetryAt: number | null = null;
  let logTail: string[] = [];
  let timer: unknown;
  // Поколение: каждый подъём, неудача и остановка его меняют — поздний ответ пробы или
  // выход старого процесса не перепишет состояние нового.
  let generation = 0;
  let stopped = false;
  let waiters: ((up: boolean) => void)[] = [];
  // Когда своё ядро впервые ушло на занятом доме — срок, за который победитель обязан подняться.
  let busySince: number | null = null;

  const schedule = (fn: () => void, ms: number): void => {
    if (timer !== undefined) timers.clear(timer);
    timer = timers.set(fn, ms);
  };
  const settleWaiters = (up: boolean): void => {
    const pending = waiters;
    waiters = [];
    for (const done of pending) done(up);
  };
  const probe = async (): Promise<CoreProbe> => {
    try {
      return await deps.probe();
    } catch (error) {
      return { kind: 'absent', reason: reasonOf(error) };
    }
  };

  /** ОС кода не отдала — итог, который ядро записало само перед выходом (тот же pid). */
  const exitOf = (seen: CoreExit, of: number | null): CoreExit =>
    (seen.code === null && seen.signal === null && of !== null ? deps.exitRecord?.(of) : null) ??
    seen;

  const fail = (seen: CoreExit, why: string): void => {
    generation += 1;
    const at = deps.now();
    const exit = exitOf(seen, pid);
    lastExit = { code: exit.code, signal: exit.signal, at: new Date(at).toISOString() };
    logTail = deps.logTail();
    pid = null;
    failures = [...failures.filter((t) => at - t < CORE_FAULT_WINDOW_MS), at];
    consecutive += 1;
    if (failures.length >= CORE_FAULT_FAILS) {
      state = 'fault';
      nextRetryAt = null;
      deps.log(`core supervisor: fault after ${failures.length} failures (${why})`);
      settleWaiters(false);
      return;
    }
    state = 'restarting';
    const delay = coreBackoffMs(consecutive);
    nextRetryAt = at + delay;
    deps.log(`core supervisor: core down (${why}), restart in ${delay} ms`);
    schedule(() => void launch(), delay);
  };

  /** Живость поднятого ядра; без кода выхода от ОС — опросом номера. */
  const watch = (current: number, exitKnown: boolean, mine: number): void => {
    schedule(() => {
      if (mine !== generation || stopped) return;
      if (!exitKnown && !deps.alive(current)) {
        fail({ code: null, signal: null }, `pid ${current} is gone`);
        return;
      }
      if (consecutive > 0 && deps.now() - upSince >= CORE_HEALTHY_MS) consecutive = 0;
      watch(current, exitKnown, mine);
    }, pollMs);
  };

  /**
   * Своё ядро ушло до готовности. Дом занят другим ядром — сверить дом заново и усыновить его (в
   * `ensure`); срок подъёма вышел, а победитель так и не поднялся, — обычная неудача.
   */
  const exitedBeforeReady = (seen: CoreExit, of: number, why: string): void => {
    const exit = exitOf(seen, of);
    const at = deps.now();
    if (exit.code !== CORE_HOME_BUSY_EXIT || (busySince !== null && at - busySince >= readyMs)) {
      fail(exit, why);
      return;
    }
    busySince ??= at;
    generation += 1;
    pid = null;
    state = 'starting';
    deps.log(`core supervisor: pid ${of} found the home held by another core, adopting it`);
    schedule(() => void ensure(), pollMs);
  };

  const becomeUp = (current: number, adopted: boolean, exitKnown: boolean): void => {
    busySince = null;
    state = 'up';
    pid = current;
    upSince = deps.now();
    nextRetryAt = null;
    deps.log(`core supervisor: core ${adopted ? 'adopted' : 'started'}, pid ${current}`);
    settleWaiters(true);
    deps.onUp?.(current, adopted);
    watch(current, exitKnown, generation);
  };

  const launch = async (): Promise<void> => {
    generation += 1;
    const mine = generation;
    state = 'starting';
    nextRetryAt = null;
    let spawned: SpawnedCore;
    try {
      spawned = await deps.spawn();
    } catch (error) {
      if (mine === generation && !stopped) fail({ code: null, signal: null }, reasonOf(error));
      return;
    }
    if (mine !== generation || stopped) return;
    pid = spawned.pid;
    const exitKnown = spawned.exited !== undefined;
    let ready = false;
    spawned.exited?.then((exit) => {
      if (mine !== generation || stopped) return;
      const why = `exit ${exit.code ?? exit.signal}`;
      if (ready) fail(exit, why);
      else exitedBeforeReady(exit, spawned.pid, why);
    });
    const started = deps.now();
    const check = async (): Promise<void> => {
      if (mine !== generation || stopped) return;
      const seen = await probe();
      if (mine !== generation || stopped) return;
      if (seen.kind === 'up' && seen.pid === spawned.pid) {
        ready = true;
        becomeUp(spawned.pid, false, exitKnown);
        return;
      }
      if (!exitKnown && !deps.alive(spawned.pid)) {
        exitedBeforeReady(
          { code: null, signal: null },
          spawned.pid,
          `pid ${spawned.pid} died before ready`,
        );
        return;
      }
      if (deps.now() - started >= readyMs) {
        // Своё ядро, не ответившее за срок, — зависло на загрузке: снимаем, иначе следующая
        // попытка подняла бы второе рядом с живым первым.
        deps.kill(spawned.pid);
        fail({ code: null, signal: null }, `not ready in ${readyMs} ms`);
        return;
      }
      schedule(() => void check(), pollMs);
    };
    await check();
  };

  /** `ensureCore`: живое ядро дома — усыновить; строка без подтверждения — подождать; нет — поднять. */
  const ensure = async (): Promise<void> => {
    generation += 1;
    const mine = generation;
    state = 'starting';
    nextRetryAt = null;
    const began = deps.now();
    for (;;) {
      const seen = await probe();
      if (mine !== generation || stopped) return;
      if (seen.kind === 'up') {
        becomeUp(seen.pid, true, false);
        return;
      }
      // Строка без подтверждения у живого процесса — чаще всего `pnpm core`, который ещё не
      // слушает порт. Ждём срок подъёма; дальше поднимаем своё (P83: сборок может быть
      // несколько, прокладка возьмёт последнюю).
      if (seen.kind === 'absent' || deps.now() - began >= readyMs) break;
      await new Promise<void>((done) => schedule(done, pollMs));
      if (mine !== generation || stopped) return;
    }
    await launch();
  };

  const status = (): CoreSupervisorStatus => {
    const now = deps.now();
    return {
      state,
      pid,
      restarts: failures.filter((t) => now - t < CORE_FAULT_WINDOW_MS).length,
      lastExit,
      nextRetryAt: nextRetryAt === null ? null : new Date(nextRetryAt).toISOString(),
      logTail,
      autostart: deps.autostart(),
    };
  };

  return {
    start: () => void ensure(),
    status,
    restart: () => {
      if (state === 'up' || stopped) return status();
      failures = [];
      consecutive = 0;
      void ensure();
      return status();
    },
    whenUp: (ms) => {
      if (state === 'up') return Promise.resolve(true);
      if (stopped || state === 'fault') return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        let settled = false;
        const done = (up: boolean): void => {
          if (settled) return;
          settled = true;
          resolve(up);
        };
        waiters.push(done);
        const handle = setTimeout(() => done(false), ms);
        handle.unref();
      });
    },
    stop: () => {
      stopped = true;
      generation += 1;
      if (timer !== undefined) timers.clear(timer);
      settleWaiters(false);
    },
  };
}
