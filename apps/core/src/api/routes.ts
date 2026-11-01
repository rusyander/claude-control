import type { FastifyInstance } from 'fastify';
import type { Fact } from '@agentdeck/contracts/core/facts';
import type { RoutesReply, RouteView } from '@agentdeck/contracts/core/panel-api';
import type { Route, RouteLimit } from '@agentdeck/contracts/core/routes';
import { apiError } from './errors.ts';
import type { RouteContext } from './route-context.types.ts';

/**
 * `GET /v1/routes` (07:3-16, 11 §Policy, F8) — маршруты моделей этой загрузки для панели: вид,
 * наличие доступа, цена, предел, модели, исчерпание. Значение доступа не уходит никогда (P111):
 * из ответа читателя `credential` берутся ровно два поля — вид и наличие, — а не весь объект,
 * поэтому читатель, по ошибке вернувший ключ, его в ответ не протащит. Факт, который ядро не
 * прочитало, — `null`, не догадка; один нечитаемый маршрут не валит список.
 */

const valueOf = <T>(fact: Fact<T>): T | null => ('value' in fact ? fact.value : null);

/** Чтение маршрута не бросает наружу: сбой читателя — это `unknown`, а не 500 всего списка. */
async function settle<T>(read: () => Promise<Fact<T>>): Promise<Fact<T>> {
  try {
    return await read();
  } catch (error) {
    return { unknown: error instanceof Error ? error.message : String(error) };
  }
}

/** 402 маршрута держится до `clear-exhausted` человека (P122): предел вида `budget` с моментом. */
function exhaustedOf(limit: RouteLimit | null): boolean {
  return limit?.kind === 'budget' && limit.exhaustedAt !== undefined;
}

export async function routeViewOf(route: Route): Promise<RouteView> {
  const [credential, limit, models] = await Promise.all([
    settle(() => route.read.credential()),
    settle(() => route.read.limit()),
    settle(() => route.read.models()),
  ]);
  const modelList = valueOf(models);
  // Цена — по первой модели маршрута; маршруту без списка моделей цена всё равно говорит единицу
  // (подписка, время карты), а деньги по пустой модели таблица не даст — `null`.
  const price = await settle(() => route.read.price(modelList?.[0]?.id ?? ''));
  const cred = valueOf(credential);
  const lim = valueOf(limit);
  return {
    id: route.id,
    kind: route.kind,
    credential: cred ? { kind: cred.kind, present: cred.present === true } : null,
    // Возможности — статичное описание маршрута из реестра: доступа в них нет по построению.
    caps: route.caps,
    price: valueOf(price),
    limit: lim,
    models: modelList,
    exhausted: exhaustedOf(lim),
  };
}

export function registerRoutesView(
  app: FastifyInstance,
  ctx: RouteContext,
  routes: () => readonly Route[] | undefined,
): void {
  app.get('/v1/routes', async (request, reply) => {
    if (!ctx.requireRead(request, reply)) return reply;
    const list = routes();
    if (!list) {
      return reply.code(501).send(apiError('not-implemented', 'Реестр маршрутов не подключён'));
    }
    const body: RoutesReply = { routes: await Promise.all(list.map(routeViewOf)) };
    return body;
  });
}
