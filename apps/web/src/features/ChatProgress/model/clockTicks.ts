import type { ProgressSummary } from './progressView.types';

/**
 * Тикают ли часы полосы. Фон живёт дольше хода, поэтому таймер идущей фоновой
 * команды тикает и между ходами (живой прогон 29.09: он застывал на конце хода,
 * и «В фоне · 12м 11с» читалось как зависание). Фон мёртвого процесса уже
 * «оборван» (`shellView`) и не тикает; текущий вызов — только у живого хода.
 * Фоновый субагент между ходами — тоже: «писал 3 мин назад» обязано расти
 * (живой прогон 14.10 — агент стоял часами под надписью «работает»).
 */
export function clockTicks(summary: ProgressSummary, isRunning: boolean): boolean {
  return (
    (isRunning && Boolean(summary.activeTool)) ||
    summary.shellsRunning > 0 ||
    (!isRunning && summary.agentsRunning > 0)
  );
}
