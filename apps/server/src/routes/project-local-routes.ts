import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { LocalLayerStatus } from '@agentdeck/contracts';
import type { ServerContext } from '../context.ts';
import { claudeFolderTrust } from '../domains/local-layer/folder-trust.ts';
import { checkProjectDir } from '../domains/projects/projects.ts';
import { readProjectLocalConfig } from '../domains/project-local/project-local.ts';
import { localLayerStatus, writeLayerMode } from '../domains/local-layer/local-layer.ts';
import { requireClaudeProvider, requireProject } from './project-access.ts';

/**
 * Собственный `.claude` проекта — только чтение (см. `domains/project-local/project-local.ts`).
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

  // Локальный слой проекта (`domains/local-layer`): состояние и режим. Чтение
  // собирает слой, если командный слой изменился, — тот же путь, что у старта чата.
  // Доверие папке читается на каждый ответ (не в памяти сборки): человек мог
  // ответить «да» в терминале минуту назад (s10 G14 p7).
  const withTrust = (path: string): LocalLayerStatus => ({
    ...localLayerStatus(path),
    folderTrust: claudeFolderTrust(path, {
      legacy: join(ctx.location.paths.root, '.config.json'),
      main: ctx.location.paths.mcpConfig,
    }),
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/local-layer', (request, reply) => {
    const project = requireProject(ctx, request.params.id, reply);
    if (!project) return reply;
    return withTrust(project.path);
  });

  app.put<{ Params: { id: string }; Body: { mode?: unknown } }>(
    '/api/projects/:id/local-layer',
    (request, reply) => {
      const project = requireProject(ctx, request.params.id, reply);
      if (!project) return reply;
      const mode = request.body?.mode;
      if (mode !== 'auto' && mode !== 'on' && mode !== 'off') {
        return reply
          .code(400)
          .send({ error: 'invalid_mode', message: 'Режим слоя: auto, on или off.' });
      }
      writeLayerMode(project.path, mode);
      return withTrust(project.path);
    },
  );
}
