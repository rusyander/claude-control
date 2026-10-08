import type { PathStep, PathEntry } from '@agentdeck/contracts';

export function asEntry(step: PathStep): PathEntry {
  return { kind: 'custom', step };
}
