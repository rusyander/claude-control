import type { FastifyInstance } from 'fastify';
import { CORE_API_PREFIX } from '@agentdeck/contracts/core/panel-api';
import {
  CHAT_START_CARRY_REFUSED,
  CHAT_START_ROUTE,
  chatStartBodySchema,
} from '@agentdeck/contracts/core/estimate';
import type { ChatStartCarry } from '../../domains/chat/core-run/chat-start-carry.ts';
import type { CoreContourRoutes } from '../../domains/platform/routing/core-contour.ts';
import {
  createCoreIdentityDeps,
  type CoreIdentityDeps,
} from '../../lib/listen-identity/listen-identity.ts';
import { relayOnce, requesterPid, verifiedCore, type CoreProxyDeps } from './core-proxy-routes.ts';

/**
 * Старт чата ядра из панели (этап 10, G13). Прежде веб слал оценку чата ядру напрямую, и новый
 * разговор — Claude или чужого CLI («Новый разговор здесь») — шёл без слоя панели, который прежний
 * исполнитель клал своему процессу сам: строки о блоке «Тесты», набора, флагов наших слоёв. Здесь
 * панель собирает этот слой ТЕМ ЖЕ переносом, что ход реестра чата (G6: `session-carry.ts`), и
 * пересылает оценку ядру.
 *
 * Модель доказательства ядра не меняется: число страницы веб получил у ядра для своей загрузки,
 * панель его не чеканит и не подменяет; pid пира — браузер, ровно как у прокладки. Подписанное
 * устройством тело сюда не принимается: подпись покрывает тело без `proof`, и дописанные панелью
 * поля сломали бы её — такое тело идёт прокладкой `/api/core/estimate` как есть.
 */

export interface ChatStartRouteDeps extends CoreProxyDeps {
  carry: ChatStartCarry;
  /**
   * Маршрут контура этого чата (`coreContourRoutes`: «Чат» для Claude, `foreign:<cli>` иначе);
   * `undefined` — контур чат не ведёт. Уходит вебу полем `allowedRoutes` ответа (`ChatStartReply`).
   */
  routes?: (cli: string) => CoreContourRoutes | undefined;
}

/** Дописать маршрут к ответу оценки: только к принятому JSON, иначе тело как есть. */
function withRoutes(routes: CoreContourRoutes | undefined) {
  return (status: number, text: string): string => {
    if (!routes?.length || status < 200 || status >= 300) return text;
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return text;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return text;
    return JSON.stringify({ ...body, allowedRoutes: routes });
  };
}

const ESTIMATE_PATH = `${CORE_API_PREFIX}/estimate`;

export function registerChatStartRoute(
  app: FastifyInstance,
  deps: ChatStartRouteDeps,
  identity: (port: number) => CoreIdentityDeps = createCoreIdentityDeps(),
): void {
  app.post(CHAT_START_ROUTE, async (request, reply) => {
    const parsed = chatStartBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'chat start: invalid body',
        code: 'invalid-body',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const { cmdId, cli, fields, proof } = parsed.data;
    if (proof.signature !== undefined) {
      return reply.code(400).send({
        error: 'chat start: a device-signed estimate goes to /api/core/estimate unchanged',
        code: 'chat-start-signed',
      });
    }
    const placement = fields.placement;
    const chat = 'preset' in fields.scenario && fields.scenario.preset === 'chat';
    if (!chat || placement?.kind !== 'in-place') {
      return reply.code(400).send({
        error: 'chat start: only an in-place chat estimate takes the panel layer',
        code: 'chat-start-not-chat',
      });
    }
    // Слой собирает только панель: поле от клиента подменило бы набор и строку о тестах.
    if (fields.session !== undefined) {
      return reply.code(400).send({
        error: 'chat start: the session fields are composed by the panel, not sent',
        code: 'chat-start-session-owned',
      });
    }
    const carried = deps.carry({ cli, cwd: placement.grant.project });
    if (!carried.ok) {
      return reply.code(422).send({
        error: `the panel layer does not fit the core session: ${carried.reason}`,
        code: CHAT_START_CARRY_REFUSED,
        detail: carried.reason,
      });
    }
    const core = await verifiedCore(reply, deps, identity);
    if (!core) return reply;
    if (deps.hopGate && core.entry.supervisor) await deps.hopGate(core.entry.supervisor);
    const { session, env } = carried.carry;
    const names = Object.keys(env);
    return relayOnce(
      reply,
      core,
      {
        method: 'POST',
        path: ESTIMATE_PATH,
        body: {
          cmdId,
          fields: Object.keys(session).length > 0 ? { ...fields, session } : fields,
          proof,
          ...(names.length > 0 ? { env } : {}),
        },
        peerPid: await requesterPid(request, deps.readTcp),
      },
      withRoutes(deps.routes?.(cli)),
    );
  });
}
