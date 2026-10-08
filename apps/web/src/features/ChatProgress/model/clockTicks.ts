import type { ProgressSummary } from './progressView.types';

/**
 * Тикают ли часы полосы. Фон живёт дольше хода, поэтому таймер идущей фоновой
 * команды тикает и между ходами (живой прогон 29.09: он застывал на конце хода,
 * и «В фоне · 12м 11с» читалось как зависание). Фон мёртвого процесса уже
 * «оборван» (`shellView`) и не тикает; текущий вызов — только у живого хода.
 */
export function clockTicks(summary: ProgressSummary, isRunning: boolean): boolean {
  return (isRunning && Boolean(summary.activeTool)) || summary.shellsRunning > 0;
}
