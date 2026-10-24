import type { FastifyInstance } from 'fastify';
import type {
  DeferredAskList,
  DeferredAskView,
  DeferredDecisionResult,
} from '@agentdeck/contracts/deferred-asks';
import type { InboxDeferred } from '@agentdeck/contracts/chat-inbox';
import { deferredDecisionBodySchema } from '@agentdeck/contracts/request-bodies';
import type { ServerContext } from '../../../context.ts';
import { deferredView } from '../../../domains/chat/deferred-asks/deferred-asks.ts';
import { parseBody } from '../../../lib/request-body.ts';
import { humanOnly, humanOnlyRead } from '../human-only/human-only.ts';
import { humanOnlyDepsFor } from '../human-only/human-only-deps.ts';
import { decideDeferred, deferredAsksOf } from './deferred-store.ts';

/** Что показывает сводка телефона: ждёт, истекло (можно разрешить заново), разрешено и не использовано. */
const INBOX_STATES = new Set<DeferredAskView['state']>(['waiting', 'expired', 'allowed']);

/** Запись D-n строкой сводки (`GET /api/chat/inbox`, телефон и Telegram). */
export function inboxDeferredOf(ctx: ServerContext): InboxDeferred[] {
  return deferredAsksOf(ctx)
    .all()
    .map(deferredView)
    .filter((view) => INBOX_STATES.has(view.state))
    .map((view) => ({
      id: view.id,
      state: view.state as InboxDeferred['state'],
      kind: view.kind,
      toolName: view.toolName,
      summary: view.summary,
      ...(view.detail ? { detail: view.detail } : {}),
      reason: view.reason,
      ...(view.reasonCode ? { reasonCode: view.reasonCode } : {}),
      ...(view.reasonParams ? { reasonParams: view.reasonParams } : {}),
      askedAt: view.askedAt,
      expiresAt: view.expiresAt,
      ...(view.retries ? { retries: view.retries } : {}),
      ...(view.grantUntil ? { grantUntil: view.grantUntil } : {}),
      ...(view.chatId ? { chatId: view.chatId } : {}),
      ...(view.source.project ? { project: view.source.project } : {}),
      ...(view.source.chatTitle ? { chatTitle: view.source.chatTitle } : {}),
      ...(view.source.group ? { group: view.source.group } : {}),
      ...(view.source.groupTitle ? { groupTitle: view.source.groupTitle } : {}),
    }));
}

/**
 * Один список отложенных вопросов D-n и один путь решения — окно, телефон и
 * страница ссылки из Telegram зовут одно и то же. Решение принимает только
 * человек: процесс модели получает 403 (`human-only.ts`).
 */
export function registerDeferredRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  registry?: { allProcessRoots(): number[] },
): void {
  const humanDeps = humanOnlyDepsFor(registry);

  // Список закрыт от процесса модели: он подсказывал бы ей номера её же
  // вопросов (решение их всё равно не принимает, но перечислять их незачем).
  // Проверка мягкая — неузнанное окно список видит, иначе телефон и страница
  // ссылки из Telegram теряли бы саму ленту (D-S01).
  app.get('/api/chat/deferred', { preHandler: humanOnlyRead(humanDeps) }, (): DeferredAskList => ({
    generatedAt: new Date().toISOString(),
    items: deferredAsksOf(ctx).all().map(deferredView).reverse(),
  }));

  app.post<{ Params: { id: string }; Body: unknown }>(
    '/api/chat/deferred/:id/decision',
    { preHandler: humanOnly(humanDeps) },
    async (request, reply): Promise<DeferredDecisionResult | ReturnType<typeof reply.send>> => {
      const body = parseBody(deferredDecisionBodySchema, request.body, reply);
      if (!body) return reply;
      const { id } = request.params;
      const result = await decideDeferred(ctx, id, {
        behavior: body.behavior,
        ...(body.message ? { message: body.message } : {}),
        via: body.via ?? 'web',
      });
      if (!result) {
        return reply.code(404).send({
          code: 'deferred_not_found',
          message: `Отложенного вопроса ${id} нет: он убран или номер неверный.`,
          messageCode: 'deferred-not-found',
          params: { id },
        });
      }
      return result;
    },
  );
}
