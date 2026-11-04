import type { FastifyInstance } from 'fastify';
import type { ContourPush } from '../domains/platform/contours/index.ts';

/**
 * Ответ на изменяющий запрос уходит ПОСЛЕ того, как ядро применило правку контура к шлюзу
 * человека (s10 G7): «сохранено» в панели значит «действует», а не «подействует через такт».
 * Какой маршрут что записал, хук не знает — он сверяет отпечаток фактов контура (`contour-push.ts`),
 * поэтому правка из любого места (карточка, настройки, импорт состояния, переезд каталога)
 * доходит одинаково. Запрос, не тронувший контур, не ждёт ничего. Хук объявляется до маршрутов:
 * добавленный позже, он бы к ним не применился.
 */
export function registerContourPushHook(
  app: FastifyInstance,
  push: Pick<ContourPush, 'settle'>,
): void {
  app.addHook('onSend', async (request, _reply, payload) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') await push.settle();
    return payload;
  });
}
