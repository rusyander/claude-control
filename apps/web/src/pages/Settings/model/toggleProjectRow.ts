import type { SplitSettingsView } from '@agentdeck/contracts/task-split';
import type {
  SplitDefaults,
  GroupRequestId,
  GroupPermissionLevel,
} from '@agentdeck/contracts/split-groups';

/**
 * Строки проекта после щелчка: своё положение, либо наследование, если оно
 * совпало с общим. Возвращает то, что уходит на сервер, — только свои строки.
 */
export function toggleProjectRow(
  view: SplitSettingsView,
  defaults: SplitDefaults,
  id: GroupRequestId,
  level: GroupPermissionLevel,
): Record<string, GroupPermissionLevel> {
  const next: Record<string, GroupPermissionLevel> = {};
  for (const ownId of view.permissionsOwn) next[ownId] = view.permissions[ownId];
  if (defaults.permissions[id] === level) delete next[id];
  else next[id] = level;
  return next;
}
