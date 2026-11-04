import { routeFactDecls } from '../../facts.ts';
import { createAcquire } from './route/acquire.ts';
import { createOwnContext } from './route/context.ts';
import { createOwnEndpoint, createOwnReads } from './route/reads.ts';
import { createRelease } from './route/release.ts';
import { createRestore } from './route/restore.ts';
import { OWN_CAPS, type OwnRoute, type OwnRouteOptions } from './route/types.ts';
import { createWaiters } from './route/waiters.ts';

export { OWN_CAPS, type OwnModel, type OwnRoute, type OwnRouteOptions } from './route/types.ts';

/**
 * Маршрут `local:own` (11 R:PR-04) — протокол владельца для своего сервера моделей, исполняемый
 * кодом, а не памятью:
 * 1. слот карты (одна модель на карту, вторая ждёт, не вытесняет);
 * 2. память карты ДО загрузки → решение `fit` в журнал → не влезает — отказ без загрузки;
 * 3. сервер-маршрутизатор на выделенном порте (через хранителя — переживает ядро), одна модель;
 * 4. освобождение: выгрузка → сервер говорит «моделей нет» → остановка ДЕРЕВА → память карты
 *    прочитана обратно до исходной ± допуск → `resource.verified`, иначе `resource.leak`.
 * Ресурсы заводятся в порядке слот → каталог → сервер → загрузка, освобождаются в обратном.
 *
 * Перезапуск ядра (P10): запись аренды лежит в её каталоге (`lease-state.ts`). Новый экземпляр
 * маршрута до первой выдачи слота возвращает себе каждую аренду, чей сервер жив по личности
 * (pid + старт): слот занят ею, второй сервер и вторая загрузка не начинаются, адрес — тот же.
 * Ждущий слот хранит своё место файлом и, вернувшись с тем же taskId, проходит раньше пришедших
 * после него. Чистая остановка ядра — `shutdown()`; падение оставляет серверы следующему ядру.
 * Чужой сервер не останавливается никогда: только записанный этим маршрутом и с совпавшей ссылкой.
 *
 * Фасад: сборка из `route/` — общее состояние (`context`), непрояснённые держатели (`waiters`),
 * возврат прошлого ядра (`restore`), выдача (`acquire`), освобождение (`release`), факты (`reads`).
 */
export function createOwnRoute(options: OwnRouteOptions): OwnRoute {
  const ctx = createOwnContext(options);
  const waiters = createWaiters(ctx);
  const ensureRestored = createRestore(ctx, waiters);
  const release = createRelease(ctx, ensureRestored, waiters);
  return {
    kind: 'local',
    id: ctx.id,
    caps: OWN_CAPS,
    facts: routeFactDecls(),
    read: createOwnReads(ctx),
    acquire: createAcquire(ctx, ensureRestored, waiters, release),
    endpoint: createOwnEndpoint(ctx),
    release: release.releaseLease,
    shutdown: release.shutdown,
    restore: ensureRestored,
    slotHeld: () => ctx.slots.held(ctx.slotKey),
  };
}
