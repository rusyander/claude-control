import type { TFunction } from 'i18next';
import type { TaskListItem } from '@agentdeck/contracts/core/panel-api';
import { taskStateLabel } from '@entities/CoreTask';

/**
 * Пункты выбора живой задачи: название и состояние словами на языке панели — тем же
 * `taskStateLabel`, что у списка задач и ленты (сырое `awaiting-launch` в русской рамке читалось
 * как недоделка).
 */
export function liveTaskOptions(
  t: TFunction,
  // `state` — строка, не перечень контракта: ядро новее панели присылает состояние, которого
  // панель не знает, и оно показывается как есть.
  live: readonly (Pick<TaskListItem, 'taskId' | 'title'> & { state: string })[],
): { value: string; label: string }[] {
  return live.map((item) => ({
    value: item.taskId,
    label: `${item.title ?? item.taskId} · ${taskStateLabel(t, item.state)}`,
  }));
}
