import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context.ts';
import type { EventHub } from '../lib/event-hub.ts';

/**
 * Как часто в поток уходит пустой комментарий.
 *
 * Молчащее соединение рвут все, кто стоит между браузером и сервером, — прокси
 * разработки, NAT, спящий ноутбук, — и рвут ТИХО: сокет остаётся полуоткрытым,
 * ошибки браузер не видит, переподключаться не начинает. Панель после этого
 * живёт снимком: новый разговор из терминала или с телефона в списке не
 * появляется, лента не дописывается, и всё чинится только перезагрузкой
 * страницы. Регулярный байт в поток не даёт соединению замолчать, а если оно
 * всё-таки оборвалось — обрыв становится ЯВНЫМ, и клиент переподключается сам.
 */
export const HEARTBEAT_MS = 25_000;

/**
 * `GET /api/events` — поток SSE об изменениях файлов. Единственный маршрут,
 * который браузер открывает адресом (`EventSource`), поэтому единственный,
 * где гейт принимает токен строкой запроса (`acceptsQueryToken`).
 */
export function registerEventsRoutes(
  app: FastifyInstance,
  _ctx: ServerContext,
  hub: EventHub,
): void {
  app.get('/api/events', (request, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      // Прокси разработки и обратные прокси иначе копят ответ в буфере: события
      // приходят пачкой через минуту вместо того, чтобы приходить сразу.
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(': connected\n\n');

    const unsubscribe = hub.subscribe((payload) => {
      reply.raw.write(`data: ${payload}\n\n`);
    });

    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), HEARTBEAT_MS);
    // Таймер не должен держать процесс живым на выходе.
    heartbeat.unref?.();

    request.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}
