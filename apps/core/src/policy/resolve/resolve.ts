import { gatewayRouteId } from '../../routes/gateway/gateway.ts';
import type {
  AllowedRoute,
  AllowedSetEntry,
  AllowedSetInput,
  AllowedSetResolution,
  ContourPolicy,
  RouteNarrowing,
} from './resolve.types.ts';

/**
 * Разрешённый набор маршрутов задачи — ключ `policy/resolve` (06 §Precedence, 11 §Policy, P118).
 *
 * Порядок уровней и почему он такой:
 * 1. База — уровень 2: выбор человека при запуске + вход CLI каждого выбранного переходника
 *    (подписка всегда рядом с выбранным, 11 §Policy «subscription before paid»).
 * 2. Платформа (уровень 1): активный контур в режиме `required` сводит КАЖДУЮ тройку к своему
 *    шлюзу; шлюз лежит — ОТКАЗ, облако вендора не берётся никогда (утечка мимо контура).
 *    Применяется до уровней 3–5: «только локальная» проекта поверх обязательного контура должна
 *    стать названным отказом, а не тихой локальной моделью мимо правила компании.
 * 3. Уровни 3–5 только СУЖАЮТ: тройка слоя вне текущего набора — расширение, отвергается с
 *    именем (R:S2-18); сужение шаблона модели применяется; сужение в пустоту — отказ.
 *
 * Расширить набор может только уровень 2 — живой командой `set-route`.
 */

const label = (route: AllowedRoute): string =>
  `${route.adapter}/${route.route.id}/${route.modelPattern}`;

function globRegex(pattern: string): RegExp {
  const parts = pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${parts.join('.*')}$`);
}

/**
 * Покрывает ли шаблон `wide` всё, что покрывает `narrow`: сам `narrow` (со звёздочками как
 * символами) подходит под `wide`. Для звёздочек в хвосте — точно; иначе — с запасом в сторону
 * «не покрывает», то есть в сторону отказа, а не расширения.
 */
export function patternCovers(wide: string, narrow: string): boolean {
  if (wide === narrow || wide === '*') return true;
  return globRegex(wide).test(narrow);
}

function sameRoute(a: AllowedRoute, b: AllowedRoute): boolean {
  return a.adapter === b.adapter && a.route.kind === b.route.kind && a.route.id === b.route.id;
}

export function routeCovers(wide: AllowedRoute, narrow: AllowedRoute): boolean {
  return sameRoute(wide, narrow) && patternCovers(wide.modelPattern, narrow.modelPattern);
}

function dedup(routes: readonly AllowedRoute[]): AllowedRoute[] {
  const seen = new Set<string>();
  const out: AllowedRoute[] = [];
  for (const route of routes) {
    const key = `${route.adapter}\u0000${route.route.kind}\u0000${label(route)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(route);
  }
  return out;
}

/** Слой уровня 3–5 над текущим набором: что осталось, что применено, что отвергнуто. */
function narrow(
  current: readonly AllowedRoute[],
  layer: RouteNarrowing,
): { next: AllowedRoute[]; applied: AllowedSetEntry[]; rejected: AllowedSetEntry[] } {
  const applied: AllowedSetEntry[] = [];
  const rejected: AllowedSetEntry[] = [];
  let next = [...current];
  if (layer.routes) {
    const offered = layer.routes.filter((wanted) => {
      if (next.some((have) => routeCovers(have, wanted))) return true;
      rejected.push({
        level: layer.level,
        path: `routes.${label(wanted)}`,
        reason: `${layer.source}: adds a route outside the allowed set (only level 2 widens)`,
      });
      return false;
    });
    const kept: AllowedRoute[] = [];
    for (const have of next) {
      const inside = offered.filter((wanted) => routeCovers(have, wanted));
      if (inside.length === 0) {
        applied.push({
          level: layer.level,
          path: `routes.${label(have)}`,
          reason: `${layer.source}: not in the layer's list, narrowed away`,
        });
        continue;
      }
      for (const wanted of inside) {
        if (wanted.modelPattern !== have.modelPattern) {
          applied.push({
            level: layer.level,
            path: `routes.${label(have)}`,
            reason: `${layer.source}: model pattern narrowed to ${wanted.modelPattern}`,
          });
        }
        kept.push(wanted);
      }
    }
    next = dedup(kept);
  }
  if (layer.kinds) {
    const kinds = layer.kinds;
    next = next.filter((have) => {
      if (kinds.includes(have.route.kind)) return true;
      applied.push({
        level: layer.level,
        path: `routes.${label(have)}`,
        reason: `${layer.source}: only ${kinds.join(', ')} routes`,
      });
      return false;
    });
  }
  return { next, applied, rejected };
}

/**
 * `fill` — модель контура по умолчанию для шлюза (s10 G7): судья шага ставит её, только если
 * выбрал этот шлюз с моделью CLI по умолчанию (`model: null`); названная модель остаётся.
 */
export type ContourNarrowing =
  | {
      ok: true;
      set: AllowedRoute[];
      applied: AllowedSetEntry[];
      fill?: { routeId: string; model: string };
    }
  | { ok: false; reason: string };

/**
 * Уровень 1 (06 §Precedence, 11 §Policy): активный контур `required` ведёт каждую тройку через
 * `gateway:<id>` (переходник и шаблон модели те же); шлюз `down` — отказ, облака вендора вместо
 * него не бывает (P118). `best-effort` и «контура нет» набор не трогают. Одна функция на запуск
 * (`resolveAllowedRoutes`) и на суд `tier` шага — иначе два пути разошлись бы на первой правке.
 */
export function contourNarrow(
  set: readonly AllowedRoute[],
  contour: ContourPolicy | undefined,
): ContourNarrowing {
  if (contour?.mode !== 'required') return { ok: true, set: [...set], applied: [] };
  if (contour.gateway === 'down')
    return {
      ok: false,
      reason: `contour ${contour.contourId} is required and its gateway is down; the vendor cloud is never taken instead`,
    };
  const gatewayId = gatewayRouteId(contour.contourId);
  const applied: AllowedSetEntry[] = [];
  const next = dedup(
    set.map((have) => {
      if (have.route.kind === 'gateway' && have.route.id === gatewayId) return have;
      applied.push({
        level: 1,
        path: `routes.${label(have)}`,
        reason: `contour ${contour.contourId} is required: goes through ${gatewayId}`,
      });
      return {
        adapter: have.adapter,
        route: { kind: 'gateway' as const, id: gatewayId },
        modelPattern: have.modelPattern,
      };
    }),
  );
  const model = contour.model?.trim();
  return {
    ok: true,
    set: next,
    applied,
    ...(model ? { fill: { routeId: gatewayId, model } } : {}),
  };
}

export function resolveAllowedRoutes(input: AllowedSetInput): AllowedSetResolution {
  const applied: AllowedSetEntry[] = [];
  const rejected: AllowedSetEntry[] = [];
  const refuse = (
    code: 'route_unavailable' | 'not_allowed',
    reason: string,
  ): AllowedSetResolution => ({ kind: 'refused', code, reasons: [reason], applied, rejected });

  if (input.launch.length === 0) return refuse('not_allowed', 'no launch choice (level 2)');
  let set = [...input.launch];
  for (const adapter of new Set(input.launch.map((route) => route.adapter))) {
    const login = input.cliLoginOf(adapter);
    if (!login || set.some((have) => routeCovers(have, login))) continue;
    set.push(login);
    applied.push({
      level: 2,
      path: `routes.${label(login)}`,
      reason: `cli-login of ${adapter} joins the launch choice`,
    });
  }
  set = dedup(set);
  let sourceLevel = 2;

  const contoured = contourNarrow(set, input.contour);
  if (!contoured.ok) return refuse('route_unavailable', contoured.reason);
  applied.push(...contoured.applied);
  set = contoured.set;
  if (input.contour?.mode === 'required') sourceLevel = 1;

  const layers = [...input.narrowings].sort((a, b) => a.level - b.level);
  for (const layer of layers) {
    const result = narrow(set, layer);
    applied.push(...result.applied);
    rejected.push(...result.rejected);
    if (result.applied.length > 0 && sourceLevel !== 1) sourceLevel = layer.level;
    set = result.next;
    if (set.length === 0) {
      return refuse('not_allowed', `${layer.source}: narrowed the allowed set to nothing`);
    }
  }
  return { kind: 'set', allowedRoutes: set, sourceLevel, applied, rejected };
}
