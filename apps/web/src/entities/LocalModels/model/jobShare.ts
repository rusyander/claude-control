import type { LocalJob } from '@agentdeck/contracts/local-models';

/** Доля работы 0…1; неизвестный размер — undefined (полоса без числа). */
export function jobShare(job: LocalJob): number | undefined {
  if (job.totalBytes <= 0) return undefined;
  return Math.min(1, job.doneBytes / job.totalBytes);
}
