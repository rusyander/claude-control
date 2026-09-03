import type { FastifyInstance } from 'fastify';
import { isOAuthCallback, isRequestAllowed } from './origin-guard.ts';
import { acceptsQueryToken, isValidApiToken, presentedToken } from './api-token.ts';

export interface AccessGateDeps {
  /** Источники своего интерфейса — `allowedOrigins(WEB_PORT)`. */
  allowedOrigins: Set<string>;
  /**
   * Требовать ли токен. Читается на КАЖДЫЙ запрос, а не один раз: тумблер
   * удалённого доступа переключается на лету через PATCH /api/settings.
   */
  requiresToken: () => boolean;
  /** Ожидаемый токен; спрашивается только когда он действительно нужен. */
  expectedToken: () => string;
}

/**
 * Кто допущен к API — один хук `onRequest`, два рубежа.
 *
 * Отказ выдаётся до маршрутов и до CORS — свой обработчик, а не ошибка плагина:
 * так чужой запрос не доходит до кода, а ответ остаётся понятным (403, а не 500).
 *
 * Первый рубеж — Origin и Sec-Fetch-Site (правила и их обоснование в
 * origin-guard.ts). Второй — токен, и он поднимается только при включённом
 * удалённом доступе. Проверка Origin от телефона не защищает вовсе: заголовок
 * подделывает любой не-браузерный клиент, а через Tailscale Serve запрос
 * приходит с петли и от местного неотличим. Поэтому включённый доступ требует
 * токен ОТ ВСЕХ, включая свой интерфейс: прокси Vite подставляет его сам,
 * читая тот же файл на той же машине.
 *
 * Строкой запроса (`?token=`) токен принимают только маршруты из закрытого
 * списка `acceptsQueryToken` — те, что клиент открывает адресом. Везде
 * остальное — заголовок, чтобы токен не оседал в журналах и истории браузера.
 *
 * Отдельным модулем, а не строками в `index.ts`, ради проверки: тест поднимает
 * свой Fastify и прогоняет через ТОТ ЖЕ хук, что стоит у человека.
 */
export function registerAccessGate(app: FastifyInstance, deps: AccessGateDeps): void {
  app.addHook('onRequest', (request, reply, done) => {
    const site = request.headers['sec-fetch-site'];
    const guarded = {
      method: request.method,
      url: request.url,
      origin: request.headers.origin,
      site: typeof site === 'string' ? site : undefined,
    };

    if (!isRequestAllowed(guarded, deps.allowedOrigins)) {
      reply.code(403).send({ error: 'Запрос с постороннего сайта отклонён' });
      return;
    }

    if (deps.requiresToken() && !isOAuthCallback(guarded)) {
      const presented = presentedToken(
        request.headers.authorization,
        request.query,
        acceptsQueryToken(request.method, request.url),
      );
      if (!isValidApiToken(presented, deps.expectedToken())) {
        reply.code(401).send({ error: 'Нужен токен доступа' });
        return;
      }
    }

    done();
  });
}
