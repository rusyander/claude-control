import type { PathEntry } from '@agentdeck/contracts';

export function entryKey(entry: PathEntry, index: number): string {
  if (entry.kind === 'builtin') return `builtin:${entry.stage}`;
  if (entry.kind === 'custom') return `custom:${entry.step.id}`;
  return `skill:${entry.skillId}:${entry.index}:${index}`;
}
