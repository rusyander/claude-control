import type { CameoLine } from './cameo.types';

/** Короткий ход Деку не зовёт: он выходит, только когда ждать уже заметно. */
export const CAMEO_APPEAR_MS = 20_000;

/** Реплика висит столько, потом Дека снова молча работает рядом с таймером. */
export const CAMEO_LINE_MS = 7_000;

/** Как часто Дека что-то говорит на долгом ходу. */
export const CAMEO_EVERY_MS = 60_000;

/** С этих отметок реплика сменяется на «задача непростая» и «долгий ход». */
export const CAMEO_LONG_MS = 3 * 60_000;
export const CAMEO_VERY_LONG_MS = 10 * 60_000;

/**
 * Что показывает Дека у таймера живого прогона через `elapsed` мс от старта.
 * Появляется на 20-й секунде с первой репликой, дальше говорит раз в минуту по
 * семь секунд, а остальное время просто работает рядом — молча. Без реплик
 * (`chatty` выключен) он только работает.
 */
export function cameoLine(elapsed: number, chatty: boolean): CameoLine {
  if (elapsed < CAMEO_APPEAR_MS) return { visible: false };
  if (!chatty) return { visible: true };
  const sinceAppear = elapsed - CAMEO_APPEAR_MS;
  if (sinceAppear % CAMEO_EVERY_MS >= CAMEO_LINE_MS) return { visible: true };
  if (elapsed >= CAMEO_VERY_LONG_MS) return { visible: true, key: 'veryLong' };
  if (elapsed >= CAMEO_LONG_MS) return { visible: true, key: 'long' };
  return { visible: true, key: 'working' };
}
