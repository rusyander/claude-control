import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { BackendGuardCheck, BackendGuardStatus } from '@agentdeck/contracts';
import {
  backendGuardCheckBodySchema,
  backendGuardInstallBodySchema,
  backendGuardRemoveBodySchema,
  backendGuardSettingsBodySchema,
} from '@agentdeck/contracts/request-bodies';
import type { ServerContext } from '../../context.ts';
import {
  checkCommand,
  guardStatus,
  installGuard,
  removeGuard,
  saveGuardSettings,
} from '../../domains/backend-guard/backend-guard.ts';
import { isProjectOrCopy } from '../../domains/project-tests/project-tests.ts';
import { parseBody } from '../../lib/request-body.ts';

/**
 * Защита бэкенда проекта — вкладка «Защита» окна «Окружение». Пишет в `.claude/`
 * проекта, поэтому — только у проектов из раздела «Проекты» (как Compose и
 * база). Отказы несут `code`, тексты — у клиента.
 */
export function registerBackendGuardRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const deps = () => ({ store: ctx.store, backupDir: ctx.backupDir });

  const ownProject = (path: string | undefined, reply: FastifyReply): string | undefined => {
    if (!path || !isAbsolute(path)) {
      void reply.code(400).send({
        code: 'guard-path-required',
        message: 'Нужен абсолютный путь к каталогу проекта',
      });
      return undefined;
    }
    const projects = ctx.store.getProjects().map((project) => project.path);
    if (!isProjectOrCopy(path, projects)) {
      void reply.code(403).send({
        code: 'guard-project-unregistered',
        message:
          'Защиту панель ставит только в проекты из раздела «Проекты», каталоги внутри них и копии их веток.',
      });
      return undefined;
    }
    return path;
  };

  app.get<{ Querystring: { path?: string } }>(
    '/api/backend-guard',
    (request, reply): BackendGuardStatus | FastifyReply => {
      const root = ownProject(request.query.path, reply);
      if (!root) return reply;
      return guardStatus(deps(), root);
    },
  );

  app.post<{ Body: unknown }>('/api/backend-guard/install', (request, reply) => {
    const body = parseBody(backendGuardInstallBodySchema, request.body, reply);
    if (!body) return reply;
    const root = ownProject(body.path, reply);
    if (!root) return reply;
    return installGuard(deps(), root, body.settings, body.lang);
  });

  app.put<{ Body: unknown }>('/api/backend-guard/settings', (request, reply) => {
    const body = parseBody(backendGuardSettingsBodySchema, request.body, reply);
    if (!body) return reply;
    const root = ownProject(body.path, reply);
    if (!root) return reply;
    // Настройки без хука ничего не решают — заводить файл в непоставленной
    // защите значило бы показать «частично» там, где человек ничего не ставил.
    if (!existsSync(join(root, '.claude', 'backend-guard.json'))) {
      return reply.code(409).send({
        code: 'guard-not-installed',
        message: 'Защита в этом проекте не стоит',
      });
    }
    return saveGuardSettings(deps(), root, body.settings);
  });

  app.post<{ Body: unknown }>('/api/backend-guard/remove', (request, reply) => {
    const body = parseBody(backendGuardRemoveBodySchema, request.body, reply);
    if (!body) return reply;
    const root = ownProject(body.path, reply);
    if (!root) return reply;
    return removeGuard(deps(), root);
  });

  app.post<{ Body: unknown }>(
    '/api/backend-guard/check',
    (request, reply): BackendGuardCheck | FastifyReply => {
      const body = parseBody(backendGuardCheckBodySchema, request.body, reply);
      if (!body) return reply;
      const hit = checkCommand(body.command, body.settings);
      return hit ? { hit } : {};
    },
  );
}
