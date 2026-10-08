import type { LocalModelsInfo, LocalJobKind, LocalJob } from '@agentdeck/contracts/local-models';

export function jobFor(
  info: LocalModelsInfo | undefined,
  kind: LocalJobKind,
  target: string,
): LocalJob | undefined {
  return info?.jobs.find((job) => job.kind === kind && job.target === target);
}
