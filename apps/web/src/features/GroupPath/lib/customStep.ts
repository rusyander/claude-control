import type { PathRow } from '../model/pathRows.types';
import type { PathStep } from '@agentdeck/contracts';

export function customStep(row: PathRow): PathStep | undefined {
  return row.kind === 'entry' && row.entry.kind === 'custom' ? row.entry.step : undefined;
}
