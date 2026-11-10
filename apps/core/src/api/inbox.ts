import type { FastifyInstance } from 'fastify';
import { inboxCreateBodySchema, inboxSearchQuerySchema } from '@agentdeck/contracts/core/inbox';
import { judgeTelegramScope } from '../conductor/commands/telegram-scope.ts';
import { channelOfProof } from '../conductor/human/channel.ts';
import type { InboxPort } from '../conductor/inbox/inbox.types.ts';
import { decideAuthority } from '../policy/authority/authority.ts';
import { proofOfBody } from './body-proof.ts';
import { apiError, commandStatus } from './errors.ts';
import type { RouteContext } from './route-context.types.ts';

/**
 * Входящие ядра (этап 12, D16, P163, P167): `GET /v1/inbox/search` — поиск по источнику, ни одной
 * записи; `POST /v1/inbox` — записи доски из выбранного (или запись рукой из Telegram), никогда
 * задача. Суд полномочий `inbox-create` (человек), подпись устройства — над своим адресом и телом.
 * Повтор того же `cmdId` — ответ первого раза с `replayed: true`, ДО суда (как у доски).
 */

export const INBOX_CREATE_ROUTE = 'POST /v1/inbox';

const notWired = () =>
  apiError('not-wired', 'Входящие не подключены: проводка входящих не собрана в этом ядре');

export function registerInbox(
  app: FastifyInstance,
  ctx: RouteContext,
  port: () => InboxPort | undefined,
): void {
  app.get('/v1/inbox/search', async (request, reply) => {
    const token = ctx.tokenOf(request);
    if (token === 'none')
      return reply.code(401).send(apiError('token-required', 'Нужен токен ядра'));
    // Поиск уходит в трекер и форж с учёткой человека, а запрос пишет вызывающий: сеанс модели
    // так читал бы Jira человека своим JQL (P165, P167 — запрос поиска не идёт через модель).
    if (token === 'session')
      return reply
        .code(403)
        .send(apiError('forged-authority', 'Сеанс модели не ищет во входящих человека'));
    const got = inboxSearchQuerySchema.safeParse(request.query);
    if (!got.success)
      return reply.code(400).send(
        apiError('bad-inbox-search', 'Запрос поиска входящих не прошёл разбор', {
          issues: got.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        }),
      );
    const inbox = port();
    if (!inbox) return reply.code(501).send(notWired());
    const outcome = await inbox.search(got.data);
    if (!outcome.ok)
      return reply
        .code(outcome.status)
        .send(apiError(outcome.code, 'Источник входящих не найден', { reason: outcome.reason }));
    return reply.code(200).send(outcome.reply);
  });

  app.post('/v1/inbox', async (request, reply) => {
    const token = ctx.tokenOf(request);
    if (token === 'none')
      return reply.code(401).send(apiError('token-required', 'Нужен токен ядра'));
    const got = inboxCreateBodySchema.safeParse(request.body);
    if (!got.success)
      return reply.code(400).send(
        apiError('bad-inbox-create', 'Записи входящих не прошли разбор', {
          issues: got.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        }),
      );
    const inbox = port();
    if (!inbox) return reply.code(501).send(notWired());
    const body = got.data;
    const input = { cmdId: body.cmdId, create: body.create };
    try {
      const replayed = await inbox.replayed?.(input);
      if (replayed) return reply.code(200).send(replayed);
      const proof = await proofOfBody(
        request.raw,
        INBOX_CREATE_ROUTE,
        body as never,
        token,
        ctx.proof,
      );
      const authority = decideAuthority('inbox-create', proof);
      if (!authority.allow)
        return reply
          .code(commandStatus(authority.code))
          .send(apiError(authority.code, authority.reason));
      const scope =
        channelOfProof(proof).channel === 'telegram'
          ? judgeTelegramScope({ kind: 'inbox-create', fields: body.create }, {})
          : undefined;
      if (scope && !scope.ok)
        return reply
          .code(commandStatus('telegram-binding'))
          .send(apiError('telegram-binding', scope.reason));
      const outcome = await inbox.create(input);
      if (!outcome.ok)
        return reply
          .code(outcome.status)
          .send(
            apiError(outcome.code, 'Записи входящих не приняты', { problems: outcome.problems }),
          );
      return reply.code(200).send(outcome.reply);
    } catch (error) {
      return reply
        .code(500)
        .send(apiError('board-unreadable', 'Доска не прочиталась', { reason: String(error) }));
    }
  });
}
