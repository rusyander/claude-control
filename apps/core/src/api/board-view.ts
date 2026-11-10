import type { FastifyInstance } from 'fastify';
import type { BoardPort } from '../conductor/board/board.types.ts';
import { withRelatedHints } from '../conductor/inbox/related.ts';
import { apiError } from './errors.ts';
import type { RouteContext } from './route-context.types.ts';

/**
 * `GET /v1/board` (этап 12, P152, P159): карточки, записи и пределы доски. Читают ядро и панель;
 * колонку собирает только ядро — по фактам журнала. Хранилище не прочиталось — 500 с причиной, а
 * не пустая доска; проводки нет — 501.
 */

export function registerBoardView(
  app: FastifyInstance,
  ctx: RouteContext,
  port: () => BoardPort | undefined,
): void {
  app.get('/v1/board', async (request, reply) => {
    if (!ctx.requireRead(request, reply)) return reply;
    const board = port();
    if (!board) {
      return reply
        .code(501)
        .send(apiError('not-wired', 'Доска не подключена: проводка доски не собрана в этом ядре'));
    }
    try {
      // Подсказки «связано с …» (D26, P186) — чистая функция записей снимка, считается на чтении.
      return reply.code(200).send(withRelatedHints(await board.read()));
    } catch (error) {
      return reply
        .code(500)
        .send(apiError('board-unreadable', 'Доска не прочиталась', { reason: String(error) }));
    }
  });
}
