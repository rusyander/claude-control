/** Значок субагента: «идёт» только у идущего прогона — оборванный не работает. */
export function agentMark(status: string, isRunning: boolean): string {
  if (status === 'done') return '✓';
  if (status === 'failed') return '✕';
  return isRunning ? '▸' : '·';
}
