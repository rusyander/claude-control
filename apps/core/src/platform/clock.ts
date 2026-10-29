import { performance } from 'node:perf_hooks';
import { newId } from '../lib/ids/uuidv7.ts';

/**
 * Часы ядра (01 §Time, 09 §sleep / clock, F24). Две шкалы: стенные (`at`, UTC мс) и монотонные
 * этой загрузки (`mono`, мс от старта процесса, `bootId` называет загрузку). Длительности —
 * только по `mono` внутри одной загрузки.
 *
 * Сон машины видно двумя способами, и оба ловятся тиком раз в секунду:
 * - монотонные часы шли, а цикл событий стоял (Windows: счётчик идёт во сне) — разрыв тиков
 *   больше порога → `suspendedMs`; таймеры застоя и сроков считают «активное» время без него;
 * - монотонные стояли (Linux, macOS: CLOCK_MONOTONIC / mach_absolute_time спят вместе с
 *   машиной), а стенные ушли — `wallShiftMs`; активное время это уже не включает.
 * Долгая синхронная блокировка цикла тоже выглядит как сон и исключается из рабочего времени —
 * названная неточность, а не ложный застой.
 */

export interface ClockSource {
  wall(): number;
  mono(): number;
}

export const REAL_CLOCK: ClockSource = {
  wall: () => Date.now(),
  mono: () => performance.now(),
};

export interface ClockJump {
  wallDeltaMs: number;
  monoDeltaMs: number;
  suspendedMs: number;
  wallShiftMs: number;
}

export const TICK_MS = 1_000;
export const JUMP_THRESHOLD_MS = 5_000;

export interface CoreClock {
  readonly bootId: string;
  /** Время события. Зовёт только `journal.append` (P09): у входа записи времени нет. */
  stamp(): { at: number; mono: number };
  /** Монотонное время минус замеченные разрывы сна — для таймеров застоя и сроков (P56). */
  activeMono(): number;
  /** Сверка с прошлым тиком; разрыв больше порога — скачок часов. */
  tick(): ClockJump | undefined;
  /** Тик по таймеру; скачок уходит в `onJump` (дирижёр пишет `clock.jump` в журналы задач). */
  start(onJump: (jump: ClockJump) => void): () => void;
}

export function createClock(source: ClockSource = REAL_CLOCK, bootId: string = newId()): CoreClock {
  let lastWall = source.wall();
  let lastMono = source.mono();
  let suspendedTotal = 0;
  const clock: CoreClock = {
    bootId,
    stamp() {
      return { at: Math.trunc(source.wall()), mono: Math.round(source.mono() * 1000) / 1000 };
    },
    activeMono() {
      return source.mono() - suspendedTotal;
    },
    tick() {
      const wall = source.wall();
      const mono = source.mono();
      const wallDeltaMs = Math.round(wall - lastWall);
      const monoDeltaMs = Math.round(mono - lastMono);
      lastWall = wall;
      lastMono = mono;
      const gap = monoDeltaMs - TICK_MS;
      const suspendedMs = gap > JUMP_THRESHOLD_MS ? gap : 0;
      const wallShiftMs = wallDeltaMs - monoDeltaMs;
      if (suspendedMs === 0 && Math.abs(wallShiftMs) <= JUMP_THRESHOLD_MS) return undefined;
      suspendedTotal += suspendedMs;
      return { wallDeltaMs, monoDeltaMs, suspendedMs, wallShiftMs };
    },
    start(onJump) {
      const handle = setInterval(() => {
        const jump = clock.tick();
        if (jump) onJump(jump);
      }, TICK_MS);
      handle.unref?.();
      return () => clearInterval(handle);
    },
  };
  return clock;
}

/** Срок по активному времени: сон машины не превращается в «застой» (P56). */
export function activeElapsed(clock: CoreClock, sinceActiveMono: number): number {
  return clock.activeMono() - sinceActiveMono;
}
