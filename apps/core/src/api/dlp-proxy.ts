import type { FastifyInstance } from 'fastify';
import type { CoreDlpProxyReply } from '@agentdeck/contracts/core/hops';
import { apiError } from './errors.ts';
import type { RouteContext } from './route-context.types.ts';

/**
 * Прокси защиты данных человека (C3c): слушатель держит хост звеньев по настройкам панели.
 *   `GET /v1/dlp-proxy` — состояние сейчас (тумблер, порт, слушатель и счётчики, причина отказа);
 *   `POST /v1/dlp-proxy/apply` — такт сейчас: панель зовёт его после тумблера и правил.
 * Читать — токен ядра или Bearer панели; такт — так же, сеанс модели — `forged-authority`:
 * модель не включает и не выключает защиту своих же запросов. Прокси не подключён — 501.
 */

export interface DlpProxyPort {
  state(): CoreDlpProxyReply;
  tick(): Promise<CoreDlpProxyReply>;
}

export function registerDlpProxy(
  app: FastifyInstance,
  ctx: RouteContext,
  port: () => DlpProxyPort | undefined,
): void {
  const notImplemented = apiError('not-implemented', 'Прокси защиты данных не подключён');

  // Чтение — тоже такт: счётчики живут на хосте, а такт с той же настройкой порт не трогает.
  app.get('/v1/dlp-proxy', async (request, reply) => {
    if (!ctx.requireRead(request, reply)) return reply;
    const proxy = port();
    if (!proxy) return reply.code(501).send(notImplemented);
    return (await proxy.tick()) satisfies CoreDlpProxyReply;
  });

  app.post('/v1/dlp-proxy/apply', async (request, reply) => {
    const token = ctx.tokenOf(request);
    if (token === 'none') return reply.code(401).send(apiError('token-required', 'Нужен токен'));
    if (token === 'session')
      return reply
        .code(403)
        .send(apiError('forged-authority', 'Сеанс модели не управляет защитой данных'));
    const proxy = port();
    if (!proxy) return reply.code(501).send(notImplemented);
    return (await proxy.tick()) satisfies CoreDlpProxyReply;
  });
}
