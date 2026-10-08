import { listeners } from './agent-runs.state.constants';

export function emit(): void {
  for (const listener of listeners) listener();
}
