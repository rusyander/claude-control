import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../../context.ts';
import { publishRun, type PublishTarget } from '../../domains/integrations/publish.ts';
import { fail } from '../integrations/shared.ts';

/**
 * Отчёт по прогону — наружу, туда, где его прочтут без панели.
 *
 * Живёт отдельным файлом, а не в разделе тестов: публикация целиком принадлежит
 * интеграциям — она требует токена, привязки и живой сети, а раздел тестов
 * обязан работать и без всего этого.
 *
 * Отчёт не пишется заново: это тот же документ, что уходит файлом
 * (`export-run`), только переложенный в чужой формат.
 */
export function registerProjectTestsPublishRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.post<{ Body: unknown }>('/api/project-tests/run/publish', async (request, reply) => {
    const body = request.body as {
      path?: unknown;
      id?: unknown;
      target?: unknown;
      groupId?: unknown;
    } | null;

    const path = typeof body?.path === 'string' ? body.path.trim() : '';
    if (!path) return reply.code(400).send({ message: 'Не указан каталог проекта.' });
    const runId = typeof body?.id === 'string' ? body.id.trim() : '';
    if (!runId) return reply.code(400).send({ message: 'Не указан прогон.' });
    const target = body?.target;
    if (target !== 'confluence' && target !== 'jira') {
      return reply.code(400).send({ message: 'Публиковать можно в Confluence или в Jira.' });
    }

    try {
      return await publishRun(
        { store: ctx.store, appDataDir: ctx.location.paths.appData },
        {
          path: resolve(path),
          runId,
          target: target as PublishTarget,
          groupId: typeof body?.groupId === 'string' ? body.groupId.trim() : undefined,
        },
      );
    } catch (error) {
      return fail(reply, error);
    }
  });
}
