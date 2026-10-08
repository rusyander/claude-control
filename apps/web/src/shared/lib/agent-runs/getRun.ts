import type { AgentRun } from './agent-runs.types';
import { findKey } from './findKey';
import { runs } from './agent-runs.state.constants';
import { EMPTY_RUN } from './agent-runs.constants';

export function getRun(id: string | undefined): AgentRun {
  const key = findKey(id);
  return (key && runs.get(key)) || EMPTY_RUN;
}
