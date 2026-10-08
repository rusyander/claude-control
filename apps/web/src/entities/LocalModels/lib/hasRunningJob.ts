import type { LocalModelsInfo } from '@agentdeck/contracts/local-models';

export function hasRunningJob(info: LocalModelsInfo | undefined): boolean {
  return Boolean(info?.jobs.some((job) => job.state === 'running'));
}
