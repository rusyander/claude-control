import type { LocalModelsInfo, LocalJobKind, LocalJob } from '@agentdeck/contracts/local-models';
import { jobFor } from './jobFor';

export function runningJob(
  info: LocalModelsInfo | undefined,
  kind: LocalJobKind,
  target: string,
): LocalJob | undefined {
  const job = jobFor(info, kind, target);
  return job?.state === 'running' ? job : undefined;
}
