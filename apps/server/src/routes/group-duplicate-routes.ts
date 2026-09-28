import type { FastifyInstance } from 'fastify';
import {
  groupDuplicateRequestSchema,
  type GroupDuplicateResult,
} from '@agentdeck/contracts/groups';
import type { ServerContext } from '../context.ts';
import { saveGroupCopy } from '../domains/groups/duplicate.ts';
import { groupNotFound } from '../domains/groups/errors.ts';
import { parseGroupBody, sendGroupError } from './group-ask.ts';

/**
 * «Копировать группу»: `POST /api/groups/:id/duplicate` кладёт рядом
 * независимую выключенную копию (домен `groups/duplicate.ts`). Не путать с
 * `copy-to-global` — тот переносит проектную группу в общие вместе с файлами.
 */
export function registerGroupDuplicateRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.post<{ Params: { id: string }; Body: unknown }>(
    '/api/groups/:id/duplicate',
    (request, reply) => {
      try {
        const source = ctx.store.getGroups().find((group) => group.id === request.params.id);
        if (!source) throw groupNotFound();
        const body = parseGroupBody(groupDuplicateRequestSchema, request.body ?? {});
        const group = saveGroupCopy(ctx.store, source, body);
        return { group, sourceId: source.id } satisfies GroupDuplicateResult;
      } catch (error) {
        // Своё имя занято — 409 `group_exists` с кодом `group-name-taken`, как у создания группы.
        return sendGroupError(reply, error);
      }
    },
  );
}
