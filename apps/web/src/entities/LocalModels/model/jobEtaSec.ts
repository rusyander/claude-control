import type { LocalJob } from '@agentdeck/contracts/local-models';

/** Сколько осталось, секунд; без скорости — undefined. */
export function jobEtaSec(job: LocalJob): number | undefined {
  if (job.speed <= 0 || job.totalBytes <= 0) return undefined;
  return Math.max(0, Math.round((job.totalBytes - job.doneBytes) / job.speed));
}
