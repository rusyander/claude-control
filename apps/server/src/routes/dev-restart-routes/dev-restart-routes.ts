import type { FastifyInstance } from 'fastify';
import type { DevRestartStatus } from '@agentdeck/contracts';
import type { ServerContext } from '../../context.ts';
import { readRestartState, requestRestart } from '../../lib/dev-restart.mjs';

/**
 * Отложенный перезапуск dev-сервера (решение 30.09): пока идут ходы или
 * готовятся копии, правки сервера ждут без предела, а панель об этом говорит.
 *
 * - `GET /api/dev-restart` — ждут ли правки, какие и чего.
 * - `POST /api/dev-restart` — «перезапустить сейчас»: запрос сторожу, который
 *   исполнит его при ближайшей сверке. Идущие ходы оборвутся — это выбор
 *   человека, кнопка об этом предупреждает. Ждать нечего — запроса нет, ответ
 *   тот же статус: правки уже применились, пока человек тянулся к кнопке.
 */
export function registerDevRestartRoutes(app: FastifyInstance, ctx: ServerContext): void {
  // Каталог, который назвал сторож (он пишет состояние), а без сторожа — свой.
  const dir = (): string => process.env.AGENTDECK_DEV_RESTART_DIR || ctx.location.paths.appData;
  const status = (): DevRestartStatus => readRestartState(dir());

  app.get('/api/dev-restart', (): DevRestartStatus => status());

  app.post('/api/dev-restart', (): DevRestartStatus => {
    if (!status().pending) return status();
    requestRestart(dir());
    return status();
  });
}
