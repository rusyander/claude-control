import type { FastifyReply } from 'fastify';
import { join } from 'node:path';
import { isUuidv7 } from '@agentdeck/contracts/core/ids';
import type { TaskRegistry } from '../conductor/tasks.ts';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
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
