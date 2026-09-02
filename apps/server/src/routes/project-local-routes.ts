import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context.ts';
import { checkProjectDir } from '../domains/projects.ts';
import { readProjectLocalConfig } from '../domains/project-local.ts';
import { requireClaudeProvider, requireProject } from './project-access.ts';

/**
 * Собственный `.claude` проекта — только чтение (см. `domains/project-local.ts`).
 *
 * Два входа с одинаковым ответом: по id из реестра и по абсолютному пути.
 * Второй нужен группам, привязанным к каталогам проектов, — такой каталог в
 * реестре может и не значиться, а показать, что Claude Code из него подхватит,
 * всё равно надо.
 *
 * `/api/projects/local` — статический сегмент рядом с параметрическим `:id`;
 * find-my-way отдаёт предпочтение статике, а GET на `/api/projects/:id` без
 * хвоста и не объявлен, так что перехвата нет (закреплено тестом).
 */
export function registerProjectLocalRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get<{ Querystring: { path?: string } }>('/api/projects/local', (request, reply) => {
    if (!requireClaudeProvider(ctx, reply)) return reply;

    const path = String(request.query.path ?? '');
    const problem = checkProjectDir(path);
    if (problem) return reply.code(400).send({ error: 'invalid_path', message: problem });

    return readProjectLocalConfig(path, ctx.store);
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/local', (request, reply) => {
    const project = requireProject(ctx, request.params.id, reply);
    if (!project) return reply;
    return readProjectLocalConfig(project.path, ctx.store);
  });
}
