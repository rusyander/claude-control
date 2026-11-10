import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { boardEntriesBodySchema, boardMoveBodySchema } from '@agentdeck/contracts/core/panel-api';
import type { BoardPort } from '../conductor/board/board.types.ts';
import { judgeTelegramScope } from '../conductor/commands/telegram-scope.ts';
import { channelOfProof } from '../conductor/human/channel.ts';
import { decideAuthority } from '../policy/authority/authority.ts';
import { proofOfBody } from './body-proof.ts';
import { apiError, commandStatus } from './errors.ts';
import type { RouteContext } from './route-context.types.ts';

/**
 * Ходы человека на доске (этап 12, P152, P181, P183): `POST /v1/board/move` и
 * `POST /v1/board/entries`. Суд полномочий `board-move` (человек), подпись устройства — над своим
 * адресом и телом. Повтор того же `cmdId` — снимок с `replayed: true` без второго хода и ДО суда
 * (как у команды: повтор после краха не просит доказательство заново). Ход вне разрешённых — 409
 * со списком разрешённых, неизвестная карточка — 404, негодная запись — 422, хранилище — 500.
 */

export const BOARD_MOVE_ROUTE = 'POST /v1/board/move';
export const BOARD_ENTRIES_ROUTE = 'POST /v1/board/entries';

type Parsed<S extends z.ZodType> = { ok: true; body: z.infer<S> } | { ok: false };

/** Общий вход: токен, разбор, проводка, повтор, суд. `undefined` — ответ уже отправлен. */
async function admit<S extends z.ZodType<{ cmdId: string; proof: object }>>(
  request: FastifyRequest,
  reply: FastifyReply,
  ctx: RouteContext,
  port: () => BoardPort | undefined,
  schema: S,
  route: string,
): Promise<{ body: z.infer<S>; board: BoardPort } | undefined> {
  const token = ctx.tokenOf(request);
  if (token === 'none') {
    void reply.code(401).send(apiError('token-required', 'Нужен токен ядра'));
    return undefined;
  }
  const got = schema.safeParse(request.body);
  const parsed: Parsed<S> = got.success ? { ok: true, body: got.data } : { ok: false };
  if (!parsed.ok) {
    void reply.code(400).send(
      apiError('bad-board-move', 'Ход доски не прошёл разбор', {
        issues: got.error?.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      }),
    );
    return undefined;
  }
  const board = port();
  if (!board) {
    void reply
      .code(501)
      .send(apiError('not-wired', 'Доска не подключена: проводка доски не собрана в этом ядре'));
    return undefined;
  }
  const replayed = await board.replayed(parsed.body.cmdId);
  if (replayed) {
    void reply.code(200).send(replayed);
    return undefined;
  }
  const proof = await proofOfBody(request.raw, route, parsed.body as never, token, ctx.proof);
  const authority = decideAuthority('board-move', proof);
  if (!authority.allow) {
    void reply.code(commandStatus(authority.code)).send(apiError(authority.code, authority.reason));
    return undefined;
  }
  // Пир Telegram (этап 12, D29, P187): с доски — только «в работу»; записи и прочие ходы — панель.
  const scope =
    channelOfProof(proof).channel === 'telegram'
      ? judgeTelegramScope({ kind: 'board-move', fields: parsed.body as never }, {})
      : undefined;
  if (scope && !scope.ok) {
    void reply
      .code(commandStatus('telegram-binding'))
      .send(apiError('telegram-binding', scope.reason));
    return undefined;
  }
  return { body: parsed.body, board };
}

function storeFailed(reply: FastifyReply, error: unknown) {
  return reply
    .code(500)
    .send(apiError('board-unreadable', 'Доска не прочиталась', { reason: String(error) }));
}

export function registerBoardMove(
  app: FastifyInstance,
  ctx: RouteContext,
  port: () => BoardPort | undefined,
): void {
  app.post('/v1/board/move', async (request, reply) => {
    try {
      const got = await admit(request, reply, ctx, port, boardMoveBodySchema, BOARD_MOVE_ROUTE);
      if (!got) return reply;
      const { proof: _proof, ...move } = got.body;
      const outcome = await got.board.move(move);
      if (!outcome.ok) {
        return reply.code(outcome.status).send(
          apiError(outcome.code, 'Ход доски не разрешён', {
            allowed: outcome.allowed,
            reason: outcome.reason,
          }),
        );
      }
      return reply.code(200).send(outcome.reply);
    } catch (error) {
      return storeFailed(reply, error);
    }
  });

  app.post('/v1/board/entries', async (request, reply) => {
    try {
      const got = await admit(
        request,
        reply,
        ctx,
        port,
        boardEntriesBodySchema,
        BOARD_ENTRIES_ROUTE,
      );
      if (!got) return reply;
      const outcome = await got.board.entries(got.body);
      if (!outcome.ok) {
        return reply
          .code(422)
          .send(apiError(outcome.code, 'Записи доски не приняты', { problems: outcome.problems }));
      }
      return reply.code(200).send(outcome.reply);
    } catch (error) {
      return storeFailed(reply, error);
    }
  });
}
