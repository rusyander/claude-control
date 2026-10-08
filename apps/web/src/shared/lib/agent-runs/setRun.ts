import type { AgentRun } from './agent-runs.types';
import { runs } from './agent-runs.state.constants';
import { EMPTY_RUN } from './agent-runs.constants';

export function setRun(id: string, patch: Partial<AgentRun>): void {
  const current = runs.get(id) ?? { ...EMPTY_RUN, id };
  runs.set(id, { ...current, ...patch });
}
