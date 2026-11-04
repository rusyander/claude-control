import type { FastifyInstance } from 'fastify';
import {
  ASK_BODY_LIMIT,
  parseAskBody,
  type AskBody,
  type AskReply,
} from '@agentdeck/contracts/core/ask';
import { decideAuthority } from '../policy/authority/authority.ts';
import { proofOfBody } from './body-proof.ts';
import { apiError, commandStatus } from './errors.ts';
import type { RouteContext } from './route-context.types.ts';

/**
 * `POST /v1/ask` (этап 10, F2): лёгкая сессия панели — задача `ask@1`, один ход модели в
 * временном каталоге ядра. Ядро — единственный запускатель CLI (00): панель больше не поднимает
 * свой процесс модели, она просит ядро. Суд полномочий — класс `ask` (человек, как оценка):
 * число загрузки страницы панели + пир не из дерева сессии, или подпись устройства. Токен
 * сессии, процесс из дерева сессии, пересылка без доказательства — отказ, и отказ ложится в
 * журнал ядра (`ask.refused`): модель не заводит себе модель в обход дирижёра (P41).
 */

export const ASK_ROUTE = 'POST /v1/ask';

export interface AskPort {
  replay(cmdId: string): AskReply | undefined;
  /** `501` — дирижёр не запущен: задачу вести некому. */
  create(
    body: AskBody,
  ): Promise<
    { status: 200 | 202; reply: AskReply } | { status: 422; problems: string[] } | { status: 501 }
  >;
  refused(cmdId: string | null, code: string, reason: string): void;
}

export function registerAsk(
  app: FastifyInstance,
  ctx: RouteContext,
  port: () => AskPort | undefined,
): void {
  // Картинки вопроса не влезают в общий предел API ядра: у маршрута свой, по пределам картинок.
  app.post('/v1/ask', { bodyLimit: ASK_BODY_LIMIT }, async (request, reply) => {
    const token = ctx.tokenOf(request);
    const ask = port();
    if (token === 'none') {
      ask?.refused(null, 'token-required', 'no channel token');
      return reply.code(401).send(apiError('token-required', 'Нужен токен ядра'));
    }
    const parsed = parseAskBody(request.body);
    if (!parsed.ok) {
      // Токен сессии с негодным телом — тоже попытка: в журнал, как и годное тело.
      if (token === 'session') ask?.refused(null, 'forged-authority', 'session token, bad body');
      return reply
        .code(400)
        .send(apiError('bad-ask', 'Вопрос не прошёл разбор', { issues: parsed.issues }));
    }
    // Повтор отвечает только тому, кто вправе спросить: токену сессии — суд и отказ.
    if (token !== 'session' && ask) {
      const replayed = ask.replay(parsed.body.cmdId);
      if (replayed) return reply.code(200).send(replayed);
    }
    const authority = decideAuthority(
      'ask',
      await proofOfBody(request.raw, ASK_ROUTE, parsed.body, token, ctx.proof),
    );
    if (!authority.allow) {
      ask?.refused(parsed.body.cmdId, authority.code, authority.reason);
      return reply
        .code(commandStatus(authority.code))
        .send(apiError(authority.code, authority.reason));
    }
    const outcome = ask ? await ask.create(parsed.body) : ({ status: 501 } as const);
    if (outcome.status === 501 || !ask) {
      return reply
        .code(501)
        .send(apiError('not-wired', 'Вопрос не подключён: дирижёр не запущен в этом ядре'));
    }
    if (outcome.status === 422) {
      ask.refused(parsed.body.cmdId, 'ask-refused', outcome.problems.join('; '));
      return reply
        .code(422)
        .send(apiError('ask-refused', 'Вопрос не принят', { problems: outcome.problems }));
    }
    return reply.code(outcome.status).send(outcome.reply);
  });
}
