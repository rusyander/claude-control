import type {
  SplitDefaults,
  GroupRequestId,
  GroupPermissionLevel,
} from '@agentdeck/contracts/split-groups';

/** Общие правила после выбора положения строки. */
export function toggleDefaultRow(
  defaults: SplitDefaults,
  id: GroupRequestId,
  level: GroupPermissionLevel,
): SplitDefaults {
  return { ...defaults, permissions: { ...defaults.permissions, [id]: level } };
}
