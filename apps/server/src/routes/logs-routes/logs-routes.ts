import { isAbsolute } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ServerContext } from '../../context.ts';
import { execDocker, type DockerExec } from '../../domains/compose/compose.ts';
import { LogsError, listLogSources, readLogs, type LogsDeps } from '../../domains/logs/logs.ts';
import { isProjectOrCopy } from '../../domains/project-tests/project-tests.ts';

/**
 * Вкладка «Логи» окна «Окружение»: вывод целей «Dev-сервера» и сервисов
 * Compose. Только чтение, но в логах бывают токены и пароли — поэтому, как и
 * у API, только проекты из раздела «Проекты».
 *
 * Отказы несут свой `code` (`logs-*`), тексты — у клиента: словарь серверных
 * сообщений телефона этот раздел не трогает.
 */
export interface LogsRouteDeps {
  runs: LogsDeps['runs'];
  exec?: DockerExec;
}

const ERROR_STATUS: Record<LogsError['kind'], number> = {
  'unknown-source': 404,
  docker: 502,
};

export function registerLogsRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  deps: LogsRouteDeps,
): void {
  const logsDeps: LogsDeps = { runs: deps.runs, exec: deps.exec ?? execDocker };

  const ownProject = (path: string | undefined, reply: FastifyReply): string | undefined => {
    if (!path || !isAbsolute(path)) {
      void reply.code(400).send({
        code: 'logs-path-required',
        message: 'Нужен абсолютный путь к каталогу проекта',
      });
      return undefined;
    }
    const projects = ctx.store.getProjects().map((project) => project.path);
    if (!isProjectOrCopy(path, projects)) {
      void reply.code(403).send({
        code: 'logs-project-unregistered',
        message: 'Логи панель показывает только у проектов из раздела «Проекты».',
      });
      return undefined;
    }
    return path;
  };

  app.get<{ Querystring: { path?: string } }>('/api/logs/sources', async (request, reply) => {
    const root = ownProject(request.query.path, reply);
    if (!root) return reply;
    return listLogSources(root, logsDeps);
  });

  app.get<{ Querystring: { path?: string; source?: string; cursor?: string } }>(
    '/api/logs',
    async (request, reply) => {
      const root = ownProject(request.query.path, reply);
      if (!root) return reply;
      const source = request.query.source;
      if (!source) {
        return reply.code(400).send({ code: 'logs-source-required', message: 'Нужен source' });
      }
      try {
        return await readLogs(root, source, request.query.cursor || undefined, logsDeps);
      } catch (error) {
        if (error instanceof LogsError) {
          return reply.code(ERROR_STATUS[error.kind]).send({
            code: error.kind === 'docker' ? 'logs-docker-failed' : 'logs-source-unknown',
            message: error.message,
            ...(error.detail ? { detail: error.detail } : {}),
          });
        }
        throw error;
      }
    },
  );
}
