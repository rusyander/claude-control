import type { FastifyInstance } from 'fastify';
import type { FormatCheckReport, FormatCheckResponse } from '@claude-control/contracts';
import type { ServerContext } from '../context.ts';

/**
 * Сверка форматов чужих CLI с их официальными схемами (IDEA-3).
 *
 * `GET /api/format-check` отдаёт КЭШ и не ждёт сеть: если результат устарел,
 * обновление запускается фоном и приедет со следующим открытием раздела. Так
 * раздел настроек открывается одинаково быстро и на машине без интернета.
 *
 * `POST /api/format-check/refresh` — «проверить сейчас», единственное место, где
 * ответ ждёт сеть. Ошибка здесь не 500: недоступная схема — это результат
 * (`unavailable` у конкретного провайдера), а не поломка панели.
 */
export function registerFormatCheckRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/api/format-check', () => {
    const stale = ctx.formatCheck.isStale();
    if (stale) ctx.formatCheck.refreshIfStale();
    return {
      report: ctx.formatCheck.current(),
      stale,
    } satisfies FormatCheckResponse;
  });

  app.post(
    '/api/format-check/refresh',
    async () => (await ctx.formatCheck.refresh()) satisfies FormatCheckReport,
  );
}
