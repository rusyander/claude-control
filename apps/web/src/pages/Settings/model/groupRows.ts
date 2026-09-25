import {
  GROUP_REQUEST_IDS,
  type GroupPermissionLevel,
  type GroupRequestId,
  type SplitDefaults,
} from '@agentdeck/contracts/split-groups';
import type { SplitSettingsView } from '@agentdeck/contracts/task-split';

/**
 * Строки разрешений во вкладке «Группы»: общие и проектные.
 *
 * Строка проекта наследует общую, пока её не тронули. Тронутая строка, которую
 * вернули в положение общих, снова наследует: иначе «своё, совпадающее с
 * общим» молча переставало бы следовать за общими правилами, хотя на экране
 * ничем не отличалось бы от наследуемого.
 */

export interface GroupRow {
  id: GroupRequestId;
  /** `auto` — сама, `notify` — сама с отметкой в хабе, `human` — спросит человека. */
  level: GroupPermissionLevel;
  /** Строка задана на проекте, а не взята из общих. */
  own: boolean;
}

export function projectRows(view: SplitSettingsView): GroupRow[] {
  const own = new Set(view.permissionsOwn);
  return GROUP_REQUEST_IDS.map((id) => ({ id, level: view.permissions[id], own: own.has(id) }));
}

export function defaultRows(defaults: SplitDefaults): GroupRow[] {
  return GROUP_REQUEST_IDS.map((id) => ({ id, level: defaults.permissions[id], own: false }));
}

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

/** Общие правила после выбора положения строки. */
export function toggleDefaultRow(
  defaults: SplitDefaults,
  id: GroupRequestId,
  level: GroupPermissionLevel,
): SplitDefaults {
  return { ...defaults, permissions: { ...defaults.permissions, [id]: level } };
}
