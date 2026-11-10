import type { FastifyInstance } from 'fastify';
import type { BrowseGap, BrowseStep, WalkReply } from '@agentdeck/contracts/core/browse';
import type { RouteContext } from './route-context.types.ts';
import { readTask } from './task-read.ts';

/**
 * `GET /v1/tasks/:id/walk` (этап 12, P177) — строки прохода задачи в порядке журнала: шаги
 * `browse.step` и пробелы `browse.gap`. Из них панель собирает спек записи чистой функцией (R3).
 * Строки отдаются как лежат в журнале: секрет в них — только имя, значение туда не писалось
 * (маска — при записи, `walk-tools.ts`). `ended` — задача кончилась, новых строк не будет.
 */

export function registerWalk(app: FastifyInstance, ctx: RouteContext): void {
  app.get<{ Params: { id: string } }>('/v1/tasks/:id/walk', async (request, reply) => {
    if (!ctx.requireRead(request, reply)) return reply;
    const taskId = request.params.id;
    const task = readTask(ctx.registry, taskId, reply);
    if (!task) return reply;
    const steps: BrowseStep[] = [];
    const gaps: BrowseGap[] = [];
    for (const line of task.lines) {
      if (line.kind === 'browse.step') steps.push(line.data as BrowseStep);
      else if (line.kind === 'browse.gap') gaps.push(line.data as BrowseGap);
    }
    const body: WalkReply = { taskId, steps, gaps, ended: task.state.ended !== null };
    return body;
  });
}
