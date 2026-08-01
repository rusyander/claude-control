import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../../context.ts';
import {
  readProviderHooksInfo,
  parseProviderHooksDraft,
  saveProviderHooks,
  WriteDisabledError,
} from '../../domains/provider-hooks.ts';
import { UnrecognizedFormatError } from '../../lib/format-errors.ts';
import { done } from '../write-result.ts';
import { requireTarget } from './target.ts';
import { FORMAT_UNRECOGNIZED, HOOKS_UNSUPPORTED, INVALID_HOOKS_DRAFT } from './messages.ts';

/**
 * Хуки проекта: `experimental.hook` в `<проект>/opencode.json` (OPENCODE-3).
 *
 * Тот же домен и тот же адаптер, что у глобального раздела; отличие одно — файл
 * лежит в проекте (и он уже проверен `resolveProjectFile` на выход за него).
 */
export function registerProviderProjectHooksRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get<{ Params: { id: string } }>('/api/projects/:id/provider/hooks', (request, reply) => {
    const target = requireTarget(ctx, request.params.id, reply);
    if (!target) return reply;
    if (!target.hooks) return reply.code(400).send(HOOKS_UNSUPPORTED);

    return readProviderHooksInfo(target.hooks);
  });

  app.put<{ Params: { id: string }; Body: unknown }>(
    '/api/projects/:id/provider/hooks',
    (request, reply) => {
      const target = requireTarget(ctx, request.params.id, reply);
      if (!target) return reply;
      if (!target.hooks) return reply.code(400).send(HOOKS_UNSUPPORTED);

      const draft = parseProviderHooksDraft(request.body);
      if (!draft) return reply.code(400).send(INVALID_HOOKS_DRAFT);

      try {
        return done(saveProviderHooks(target.hooks, draft, ctx.backupDir));
      } catch (error) {
        // Ключ снят с записи (у OpenCode `experimental.hook` исчез из документации
        // и схемы) — файл в порядке, поэтому это 409, а не 422.
        if (error instanceof WriteDisabledError)
          return reply.code(409).send({ error: 'write_disabled', message: error.reason });
        if (error instanceof UnrecognizedFormatError)
          return reply.code(422).send(FORMAT_UNRECOGNIZED);
        throw error;
      }
    },
  );
}
