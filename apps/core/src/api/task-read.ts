import type { FastifyReply } from 'fastify';
import { join } from 'node:path';
import { isUuidv7 } from '@agentdeck/contracts/core/ids';
import { isGroupItem } from '../conductor/intake/index.ts';
import type { TaskRegistry } from '../conductor/tasks.ts';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import type { TaskListItem } from '@agentdeck/contracts/core/panel-api';
import { linesAfter } from '../journal/read-view.ts';
import type { TaskFoldState } from '../journal/reduce/reduce.types.ts';
import { apiError } from './errors.ts';

/**
 * Чтение задачи для ручек панели этапа 9 (запись проверки, отчёт): свёртка и строки журнала —
 * одно чтение, один набор отказов. Неверный id — 400, задачи нет — 404, журнал не читается —
 * 500 с причиной (журнал задачи, отделённой при загрузке, — не «задачи нет»).
 */

export interface TaskRead {
  state: TaskFoldState;
  lines: JournalLine[];
}

/**
 * Список задач с фильтром группы (этап 11, W3-18): `groupId` — пункты одной группы (тот же набор,
 * что `group.taskIds` ответа оценки, `isGroupItem`), `parentTaskId` — дочерние задачи XL. Поля связи
 * строка несёт всегда, с фильтром и без (ревью N-1): они в сводке реестра, второго чтения нет.
 */
export function taskListOf(
  registry: TaskRegistry,
  query: { groupId?: string; parentTaskId?: string },
): TaskListItem[] {
  return registry
    .list()
    .filter(
      (item) =>
        (query.groupId === undefined || isGroupItem(item, query.groupId)) &&
        (query.parentTaskId === undefined || item.parentTaskId === query.parentTaskId),
    );
}

/** Строка запроса списка: только строки, пустая — как нет фильтра. */
export function taskListQuery(query: unknown): { groupId?: string; parentTaskId?: string } {
  const q = (query ?? {}) as Record<string, unknown>;
  const pick = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : undefined);
  const groupId = pick(q.groupId);
  const parentTaskId = pick(q.parentTaskId);
  return {
    ...(groupId !== undefined ? { groupId } : {}),
    ...(parentTaskId !== undefined ? { parentTaskId } : {}),
  };
}

export function readTask(
  registry: TaskRegistry,
  taskId: string | undefined,
  reply: FastifyReply,
): TaskRead | undefined {
  if (!taskId || !isUuidv7(taskId)) {
    void reply.code(400).send(apiError('bad-task', 'id задачи — UUIDv7'));
    return undefined;
  }
  try {
    const state = registry.view(taskId);
    if (!state) {
      void reply.code(404).send(apiError('no-task', 'Задачи нет'));
      return undefined;
    }
    return { state, lines: linesAfter(join(registry.tasksDir, taskId), taskId, 0) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    void reply.code(500).send(apiError('journal-unreadable', reason));
    return undefined;
  }
}
