import { isAbsolute } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ServerContext } from '../../context.ts';
import {
  ComposeBusyError,
  ComposeReader,
  ComposeRegistry,
  execDocker,
  findComposeFile,
  spawnDocker,
} from '../../domains/compose/compose.ts';
import type { DockerExec, DockerSpawn } from '../../domains/compose/compose.ts';
import { isProjectOrCopy } from '../../domains/project-tests/project-tests.ts';
import { parseBody } from '../../lib/request-body.ts';
import { composeActionBodySchema } from '@agentdeck/contracts/request-bodies';

/**
 * Docker Compose проекта: вкладка «Сервисы» окна «Окружение».
 *
 * Отказы несут свой `code`, а не `messageCode`: тексты для них — у клиента, а
 * словарь серверных сообщений телефона этот раздел не трогает. `message` —
 * для `curl` руками.
 */
export interface ComposeRouteDeps {
  exec?: DockerExec;
  spawn?: DockerSpawn;
}

export function registerComposeRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  deps: ComposeRouteDeps = {},
): void {
  const reader = new ComposeReader(deps.exec ?? execDocker);
  // Действие упало — состояние демона спросим заново, а не через 10 секунд.
  const registry = new ComposeRegistry(deps.spawn ?? spawnDocker, (_path, job) => {
    if (job.status === 'failed') reader.forgetDocker();
  });

  const requirePath = (path: string | undefined, reply: FastifyReply): string | undefined => {
    if (path && isAbsolute(path)) return path;
    void reply.code(400).send({
      code: 'compose-path-required',
      message: 'Нужен абсолютный путь к каталогу проекта',
    });
    return undefined;
  };

  /** Смотреть можно где угодно; поднимать и удалять — только у своих проектов, как dev-сервер. */
  app.get<{ Querystring: { path?: string } }>('/api/compose', async (request, reply) => {
    const path = requirePath(request.query.path, reply);
    if (!path) return reply;
    return reader.describe(path, registry);
  });

  app.post('/api/compose/action', async (request, reply) => {
    const body = parseBody(composeActionBodySchema, request.body, reply);
    if (!body) return reply;
    const path = requirePath(body.path, reply);
    if (!path) return reply;

    const projects = ctx.store.getProjects().map((project) => project.path);
    if (!isProjectOrCopy(path, projects)) {
      return reply.code(403).send({
        code: 'compose-project-unregistered',
        message:
          'Контейнеры панель поднимает только у проектов из раздела «Проекты», каталогов внутри них и копий их веток.',
      });
    }
    if (body.action === 'down-volumes' && body.confirm !== true) {
      return reply.code(400).send({
        code: 'compose-confirm-required',
        message: 'Удаление томов стирает данные — нужно подтверждение (confirm: true).',
      });
    }

    const location = findComposeFile(path);
    if (!location) {
      return reply.code(404).send({
        code: 'compose-file-missing',
        message: 'В проекте нет compose.yaml / docker-compose.yml.',
      });
    }
    if (body.service) {
      const { stack } = await reader.declared(location);
      if (!stack?.services.some((service) => service.name === body.service)) {
        return reply.code(400).send({
          code: 'compose-service-unknown',
          message: `В ${location.file} нет сервиса «${body.service}».`,
        });
      }
    }

    try {
      registry.start(path, location.dir, body.action, body.service);
    } catch (error) {
      if (error instanceof ComposeBusyError) {
        return reply.code(409).send({
          code: 'compose-busy',
          message: 'Над этим стеком уже идёт действие — дождитесь его конца.',
          job: error.job,
        });
      }
      throw error;
    }
    return reader.describe(path, registry);
  });
}
