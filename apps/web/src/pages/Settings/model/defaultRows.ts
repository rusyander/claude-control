import type { SplitDefaults } from '@agentdeck/contracts/split-groups';
import type { GroupRow } from './groupRows.types';
import { GROUP_REQUEST_IDS } from '@agentdeck/contracts/split-groups';

export function defaultRows(defaults: SplitDefaults): GroupRow[] {
  return GROUP_REQUEST_IDS.map((id) => ({ id, level: defaults.permissions[id], own: false }));
}
