import { z } from 'zod';
import { registryId } from './ids.ts';

/**
 * Схемы маршрута модели отдельным листом: их читают и журнал, и сценарий (`model.routes`), а
 * сценарий сам входит в журнал — общий лист снимает круг импортов, на котором ESM отдаёт
 * `undefined` до объявления константы. `journal-data.ts` реэкспортирует всё отсюда.
 */

/**
 * Куда идут запросы модели и кто держит доступ (11 §Two axes): собственный вход CLI, ключ API,
 * локальный сервер моделей, шлюз контура или заглушка. Заглушка — такой же маршрут, а не особый
 * случай (владелец, 28.10). `id` — из реестра маршрутов (`cli-login:<adapter>`, `local:own`…).
 */
export const ROUTE_KINDS = ['cli-login', 'api-key', 'local', 'gateway', 'stub'] as const;
export const routeSchema = z.strictObject({ kind: z.enum(ROUTE_KINDS), id: registryId });

/** Разрешённая тройка (переходник, маршрут, шаблон модели) (11 §Policy). */
export const allowedRouteSchema = z.strictObject({
  adapter: registryId,
  route: routeSchema,
  modelPattern: z.string().min(1).max(200),
});
