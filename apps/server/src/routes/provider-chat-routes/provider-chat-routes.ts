import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ProviderChatPatchRequest } from '@agentdeck/contracts';
import type { ServerContext } from '../../context.ts';
import { getActiveProvider, isKnownProviderId } from '../../providers/registry.ts';
import {
  deleteChat,
  listChats,
  patchChat,
  readChat,
} from '../../domains/provider-chat/store/store.ts';
import { serverText } from '../../lib/server-texts/server-texts.ts';
import { registerProviderChatProjectsRoute } from '../provider-chat-projects-route/provider-chat-projects-route.ts';

/**
 * Старые разговоры чужих CLI — только история (этап 10, F2c). Чат любого CLI идёт через ядро
 * (`chat@1`, обычный `/chat` на CLI чата): ход, остановка, перезапуск, очередь и ответ на запрос прав
 * здесь отвечают отказом по имени `provider-chat-core`, а не запускают прежний исполнитель —
 * второго пути к CLI у панели нет. Переписка, которую вела панель, остаётся на диске и
 * читается: список, разговор, переименование и удаление процессов не запускают.
 *
 * Провайдер берётся из настроек: разговоры лежат по провайдерам и принадлежат активному.
 * Телефон по уведомлению может открыть разговор другого CLI (`?provider=`) — только чтение.
 */

/** Маршруты прежнего исполнителя: каждый отвечает отказом по имени (старые сборки телефона). */
const RETIRED_RUN_ROUTES: ReadonlyArray<readonly ['GET' | 'POST' | 'DELETE', string]> = [
  ['POST', '/api/provider-chat/chats'],
  ['POST', '/api/provider-chat/chats/:id/send'],
  ['POST', '/api/provider-chat/chats/:id/restart'],
  ['POST', '/api/provider-chat/chats/:id/stop'],
  ['DELETE', '/api/provider-chat/chats/:id/queue/:queuedId'],
  ['POST', '/api/provider-chat/chats/:id/queue/:queuedId/send'],
  ['POST', '/api/provider-chat/chats/:id/permissions/:askId'],
  ['GET', '/api/provider-chat/chats/:id/status'],
  ['GET', '/api/provider-chat/chats/:id/stream'],
];

export function registerProviderChatRoutes(app: FastifyInstance, ctx: ServerContext): void {
  /** Активный провайдер или отказ: у Claude собственный чат, эти маршруты не для него. */
  const requireProvider = (reply: FastifyReply): string | undefined => {
    const provider = getActiveProvider(ctx.store);
    if (provider.id === 'claude') {
      void reply.code(400).send({
        message: 'У Claude собственный чат — эти маршруты не для него.',
        messageCode: 'foreign-chat-not-for-claude',
      });
      return undefined;
    }
    return provider.id;
  };

  const appData = (): string => ctx.location.paths.appData;
  const notFound = (reply: FastifyReply) =>
    reply.code(404).send({ message: 'Разговор не найден', messageCode: 'conversation-not-found' });

  // Проекты всех провайдеров — своим модулем; ими же пользуется форма чата ядра.
  registerProviderChatProjectsRoute(app, ctx);

  app.get('/api/provider-chat/chats', (_request, reply) => {
    const providerId = requireProvider(reply);
    if (!providerId) return reply;
    return listChats(appData(), providerId);
  });

  app.get<{ Params: { id: string }; Querystring: { provider?: string } }>(
    '/api/provider-chat/chats/:id',
    (request, reply) => {
      const asked = request.query.provider;
      const providerId =
        asked && asked !== 'claude' && isKnownProviderId(asked) ? asked : requireProvider(reply);
      if (!providerId) return reply;
      return readChat(appData(), providerId, request.params.id) ?? notFound(reply);
    },
  );

  // Переименование — единственная правка истории: каталог и тумблер правок значили что-то
  // только для следующего хода, а ходов здесь больше нет.
  app.patch<{ Params: { id: string }; Body: ProviderChatPatchRequest }>(
    '/api/provider-chat/chats/:id',
    (request, reply) => {
      const providerId = requireProvider(reply);
      if (!providerId) return reply;
      const title = request.body?.title;
      const chat = patchChat(
        appData(),
        providerId,
        request.params.id,
        title === undefined ? {} : { title },
      );
      return chat ?? notFound(reply);
    },
  );

  app.delete<{ Params: { id: string } }>('/api/provider-chat/chats/:id', (request, reply) => {
    const providerId = requireProvider(reply);
    if (!providerId) return reply;
    return deleteChat(appData(), providerId, request.params.id) ? { ok: true } : notFound(reply);
  });

  // 410: маршрут был и ушёл навсегда — клиент не повторяет запрос, а показывает причину.
  for (const [method, url] of RETIRED_RUN_ROUTES) {
    app.route({
      method,
      url,
      handler: (_request, reply) =>
        reply.code(410).send({
          message: serverText('provider-chat-core'),
          messageCode: 'provider-chat-core',
        }),
    });
  }
}
