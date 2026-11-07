import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  PANEL_LINK_ROUTE,
  type CoreRouteLinkBody,
  type CoreContourLinkReply,
  type CoreContourNoticesReply,
  type CoreContourRunReply,
  type CoreContoursApplyReply,
  type CoreContoursReply,
  type CoreContourSummarizedReply,
} from '@agentdeck/contracts/core/hops';
import { apiError } from './errors.ts';
import type { RouteContext } from './route-context.types.ts';

/**
 * Учёт контуров (этап 10, C3b): то, что панель считала в своём шлюзе, ведёт звено ядра, а
 * панель читает отсюда — одна цифра на машину.
 *   `GET /v1/contours` — след и счётчики звена от запуска + дни расхода по контурам;
 *   `GET /v1/contours/notices?after=<seq>` — перейдённые пороги бюджета (каналы панели);
 *   `GET /v1/contours/run?tag=&since=` — сжатие и вызовы инструментов прогона чужого CLI;
 *   `GET /v1/contours/summarized` — id сообщений со сжатием истории (лента Claude);
 *   `POST /v1/contours/apply` — панель записала контур: шлюз человека настраивается сейчас;
 *   `POST /v1/contours/:id/clear-exhausted` — человек снял отметку «бюджет исчерпан»;
 *   `POST /v1/contours/:id/link` — адрес звена и заглушка ключа для запросов самой панели
 *   (картинки, презентации) — они идут через звено, как запросы CLI;
 *   `POST /v1/links` `{routeId, fresh?}` — то же для прямого вызова API панели по ключу
 *   (`api-key:<cli>`, `api-key:endpoint:<id>`, Q5).
 * Читать — токен ядра или Bearer панели; писать — так же, токен сеанса — `forged-authority`:
 * модель не правит учёт своих же трат. Порта нет — 501, звено не отвечает — 503.
 */

export interface ContoursPort {
  read(): Promise<CoreContoursReply>;
  /** Только живое звено: без него трафика не было и извещать не о чем. */
  notices(after: number): Promise<CoreContourNoticesReply['notices']>;
  clearExhausted(platformId: string): Promise<boolean>;
  run(runTag: string, since: number): Promise<CoreContourRunReply>;
  summarizedIds(): Promise<string[]>;
  /**
   * Адрес звена для запросов самой панели в контур (метка `panel:<id>`); `null` — контура нет
   * или он выключен. Хост отказал регистрации — `ContourLinkRefused`.
   */
  link(platformId: string, fresh: boolean): Promise<CoreContourLinkReply | null>;
  /**
   * То же для прямого вызова API панели по ключу (метка `panel:<routeId>`, Q5): маршрут
   * `api-key:…`; `null` — профиля нет. Отказ хоста — `ContourLinkRefused`.
   */
  linkRoute(routeId: string, fresh: boolean): Promise<CoreContourLinkReply | null>;
  /**
   * Панель записала контур: шлюз человека настраивается сейчас (s10 G7), ответ — когда хост принял
   * маршруты. Шлюза у этого ядра нет — `applied: false`.
   */
  applyUserGateway(): Promise<CoreContoursApplyReply>;
}

/** Хост отказал регистрации метки панели (перевода нет, драйвер не тот, …) — его код и слова. */
export class ContourLinkRefused extends Error {
  readonly code: string;
  constructor(code: string, detail: string) {
    super(detail);
    this.code = code;
  }
}

/** Метка прогона — то, что панель выдаёт в адрес шлюза: без пробелов и разумной длины. */
const RUN_TAG = /^[\w.-]{1,128}$/;

const MAX_PLATFORM_ID = 200;

function unavailable(reply: FastifyReply, error: unknown): FastifyReply {
  return reply
    .code(503)
    .send(
      apiError(
        'hop-unavailable',
        `Звено ядра не ответило: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
}

export function registerContours(
  app: FastifyInstance,
  ctx: RouteContext,
  port: () => ContoursPort | undefined,
): void {
  const notImplemented = apiError('not-implemented', 'Учёт контуров не подключён');

  /** Запись: токен ядра или Bearer панели; сеанс — подделка полномочий, без токена — 401. */
  const refuseWrite = (
    token: ReturnType<RouteContext['tokenOf']>,
    reply: FastifyReply,
  ): FastifyReply | undefined => {
    if (token === 'none') return reply.code(401).send(apiError('token-required', 'Нужен токен'));
    if (token === 'session')
      return reply
        .code(403)
        .send(apiError('forged-authority', 'Сеанс модели не пишет учёт контуров'));
    return undefined;
  };

  app.get('/v1/contours', async (request, reply) => {
    if (!ctx.requireRead(request, reply)) return reply;
    const contours = port();
    if (!contours) return reply.code(501).send(notImplemented);
    try {
      return await contours.read();
    } catch (error) {
      return unavailable(reply, error);
    }
  });

  app.get<{ Querystring: { after?: string } }>('/v1/contours/notices', async (request, reply) => {
    if (!ctx.requireRead(request, reply)) return reply;
    const contours = port();
    if (!contours) return reply.code(501).send(notImplemented);
    const after = Number(request.query.after ?? '0');
    if (!Number.isInteger(after) || after < 0)
      return reply.code(400).send(apiError('bad-cursor', 'after — целое число ≥ 0'));
    try {
      return { notices: await contours.notices(after) } satisfies CoreContourNoticesReply;
    } catch (error) {
      return unavailable(reply, error);
    }
  });

  app.get<{ Querystring: { tag?: string; since?: string } }>(
    '/v1/contours/run',
    async (request, reply) => {
      if (!ctx.requireRead(request, reply)) return reply;
      const contours = port();
      if (!contours) return reply.code(501).send(notImplemented);
      const tag = request.query.tag ?? '';
      // Пустой `since` — не 0 (`Number('')`): иначе ответ сложил бы весь след звена.
      const rawSince = request.query.since ?? '';
      const since = rawSince === '' ? Number.NaN : Number(rawSince);
      if (!RUN_TAG.test(tag) || !Number.isInteger(since) || since < 0)
        return reply
          .code(400)
          .send(apiError('bad-run', 'tag — метка прогона, since — целое число мс ≥ 0'));
      try {
        return (await contours.run(tag, since)) satisfies CoreContourRunReply;
      } catch (error) {
        return unavailable(reply, error);
      }
    },
  );

  app.get('/v1/contours/summarized', async (request, reply) => {
    if (!ctx.requireRead(request, reply)) return reply;
    const contours = port();
    if (!contours) return reply.code(501).send(notImplemented);
    try {
      return { messageIds: await contours.summarizedIds() } satisfies CoreContourSummarizedReply;
    } catch (error) {
      return unavailable(reply, error);
    }
  });

  // Правка контура в панели доходит до шлюза человека сразу, а не на такте ядра (5 с): обещание
  // карточки «закрывает раздел в шлюзе сразу» держит этот зов. Как запись: сеанс модели не правит
  // свой же доступ.
  app.post('/v1/contours/apply', async (request, reply) => {
    const refused = refuseWrite(ctx.tokenOf(request), reply);
    if (refused) return refused;
    const contours = port();
    if (!contours) return reply.code(501).send(notImplemented);
    try {
      return (await contours.applyUserGateway()) satisfies CoreContoursApplyReply;
    } catch (error) {
      return unavailable(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>(
    '/v1/contours/:id/clear-exhausted',
    async (request, reply) => {
      const refused = refuseWrite(ctx.tokenOf(request), reply);
      if (refused) return refused;
      const contours = port();
      if (!contours) return reply.code(501).send(notImplemented);
      // Id контура — любая непустая строка (схема контура панели), здесь только потолок длины.
      const id = request.params.id;
      if (id.length === 0 || id.length > MAX_PLATFORM_ID)
        return reply.code(400).send(apiError('bad-platform', 'Неверный id контура'));
      try {
        return { cleared: await contours.clearExhausted(id) };
      } catch (error) {
        return unavailable(reply, error);
      }
    },
  );

  /** Выдача заглушки: `null` — 404 со словами `missing`, отказ хоста — 409, нет связи — 503. */
  const sendLink = async (
    reply: FastifyReply,
    make: () => Promise<CoreContourLinkReply | null>,
    missing: { code: string; text: string },
  ): Promise<FastifyReply | CoreContourLinkReply> => {
    try {
      const link = await make();
      if (!link) return reply.code(404).send(apiError(missing.code, missing.text));
      return link;
    } catch (error) {
      if (error instanceof ContourLinkRefused)
        return reply.code(409).send(
          apiError('link-refused', `Звено не приняло маршрут: ${error.message}`, {
            hopCode: error.code,
          }),
        );
      return unavailable(reply, error);
    }
  };

  // Заглушка ключа — полномочие ходить в контур: как запись, сеансу модели её не выдают.
  app.post<{ Params: { id: string } }>('/v1/contours/:id/link', async (request, reply) => {
    const refused = refuseWrite(ctx.tokenOf(request), reply);
    if (refused) return refused;
    const contours = port();
    if (!contours) return reply.code(501).send(notImplemented);
    const id = request.params.id;
    if (id.length === 0 || id.length > MAX_PLATFORM_ID)
      return reply.code(400).send(apiError('bad-platform', 'Неверный id контура'));
    const body = request.body as { fresh?: unknown } | undefined;
    return sendLink(reply, () => contours.link(id, body?.fresh === true), {
      code: 'unknown-platform',
      text: `Контура ${id} нет среди включённых в панели`,
    });
  });

  // Прямой вызов API панели по ключу (свой эндпоинт, ключ вендора) — тем же звеном (Q5).
  app.post('/v1/links', async (request, reply) => {
    const refused = refuseWrite(ctx.tokenOf(request), reply);
    if (refused) return refused;
    const contours = port();
    if (!contours) return reply.code(501).send(notImplemented);
    const body = request.body as Partial<Record<keyof CoreRouteLinkBody, unknown>> | undefined;
    const routeId = typeof body?.routeId === 'string' ? body.routeId : '';
    if (!PANEL_LINK_ROUTE.test(routeId))
      return reply
        .code(400)
        .send(
          apiError(
            'bad-route',
            'routeId — маршрут ключа API (api-key:<cli> или api-key:endpoint:<id>)',
          ),
        );
    return sendLink(reply, () => contours.linkRoute(routeId, body?.fresh === true), {
      code: 'unknown-route',
      text: `Маршрута ${routeId} нет: ключ или профиль не сохранён в панели`,
    });
  });
}
