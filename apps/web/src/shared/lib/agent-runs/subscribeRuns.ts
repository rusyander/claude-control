import { listeners } from './agent-runs.state.constants';

export function subscribeRuns(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
