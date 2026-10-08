import { GROUP_REQUEST_IDS } from '@agentdeck/contracts/split-groups';
import type { SplitSettingsView } from '@agentdeck/contracts/task-split';
import type { GroupRow } from './groupRows.types';

export function projectRows(view: SplitSettingsView): GroupRow[] {
  const own = new Set(view.permissionsOwn);
  return GROUP_REQUEST_IDS.map((id) => ({ id, level: view.permissions[id], own: own.has(id) }));
}
