import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../../context.ts';
import {
  saveProviderPermissions,
  parseProviderPermissionsDraft,
  isCliOnlyGeminiApprovalMode,
  buildProviderPermissionInfo,
} from '../../domains/provider-permissions.ts';
import { UnrecognizedFormatError } from '../../lib/format-errors.ts';
import { done } from '../write-result.ts';
import { requireTarget } from './target.ts';
import {
  FORMAT_UNRECOGNIZED,
  INVALID_PERMISSIONS_DRAFT,
  MODE_CLI_ONLY,
  PERMISSIONS_UNSUPPORTED,
} from './messages.ts';

/** Права/аппрувы проекта: тот же адаптер, что и глобально, файл в проекте. */
export function registerProviderProjectPermissionsRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
): void {
  app.get<{ Params: { id: string } }>(
    '/api/projects/:id/provider/permissions',
    (request, reply) => {
      const target = requireTarget(ctx, request.params.id, reply);
      if (!target) return reply;
      if (!target.permissions) return reply.code(400).send(PERMISSIONS_UNSUPPORTED);
      // Сводку строит ТА ЖЕ функция, что и глобальный маршрут (`gemini-json` у
      // Gemini, `qwen-json` у Qwen Code, `opencode-json` у OpenCode) — модели не
      // могут разъехаться.
      return buildProviderPermissionInfo(target.permissions);
    },
  );

  app.put<{ Params: { id: string }; Body: unknown }>(
    '/api/projects/:id/provider/permissions',
    (request, reply) => {
      const target = requireTarget(ctx, request.params.id, reply);
      if (!target) return reply;
      if (!target.permissions) return reply.code(400).send(PERMISSIONS_UNSUPPORTED);

      const draft = parseProviderPermissionsDraft(request.body, target.permissions.format);
      if (!draft) {
        // `yolo` отклоняем отдельным сообщением: у Gemini это режим только для
        // флага CLI, в settings.json он ломает запуск.
        if (
          target.permissions.format === 'gemini-json' &&
          isCliOnlyGeminiApprovalMode(request.body)
        ) {
          return reply.code(400).send(MODE_CLI_ONLY);
        }
        return reply.code(400).send(INVALID_PERMISSIONS_DRAFT);
      }

      try {
        return done(saveProviderPermissions(target.permissions, draft, ctx.backupDir));
      } catch (error) {
        if (error instanceof UnrecognizedFormatError)
          return reply.code(422).send(FORMAT_UNRECOGNIZED);
        throw error;
      }
    },
  );
}
