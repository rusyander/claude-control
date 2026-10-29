import type { Route, RouteId, RouteKind } from '@agentdeck/contracts/core/routes';

/**
 * Реестр маршрутов (11 R:PR-08): части ядра перебирают маршруты и берут их по непрозрачному id
 * из решения, но никогда не называют. Id сверяется здесь, в рантайме; чужой id — ошибка с
 * перечнем известных, а не молчаливое «нет маршрута».
 */

export interface RouteRegistry {
  list(): readonly Route[];
  ofKind(kind: RouteKind): readonly Route[];
  get(id: RouteId): Route | undefined;
  /** Маршрут из решения: id не из реестра — ошибка, решение ссылается на несуществующее. */
  require(id: RouteId): Route;
}

export function createRouteRegistry(routes: readonly Route[]): RouteRegistry {
  const byId = new Map<RouteId, Route>();
  for (const route of routes) {
    if (!route.id.trim()) throw new Error('route with an empty id');
    // Два маршрута с одним id — решение совместимости и журнал не различили бы их.
    if (byId.has(route.id)) throw new Error(`duplicate route id ${route.id}`);
    byId.set(route.id, route);
  }
  const all = Object.freeze([...routes]);
  return {
    list: () => all,
    ofKind: (kind) => all.filter((route) => route.kind === kind),
    get: (id) => byId.get(id),
    require: (id) => {
      const route = byId.get(id);
      if (!route) throw new Error(`unknown route id ${id}; known: ${[...byId.keys()].join(', ')}`);
      return route;
    },
  };
}
