import type { RouteView } from '@agentdeck/contracts/core/panel-api';

/**
 * Строка маршрута для экрана (`GET /v1/routes`, 11 §Policy): ключи словаря и их параметры. О
 * доступе — только вид и наличие (P111): значения в ответе нет, и строка его не ищет. Факт, который
 * ядро не прочитало (`null`), показывается как «не прочитан», а не как «нет».
 */

export interface TextRef {
  key: string;
  params?: Record<string, string | number>;
}

export interface RouteLine {
  id: string;
  kind: RouteView['kind'];
  credential: TextRef;
  price: TextRef;
  limit: TextRef;
  /** Имена моделей; `null` — список не прочитан. */
  models: string[] | null;
  exhausted: boolean;
}

const P = 'coreLaunch.routes';

function credentialOf(c: RouteView['credential']): TextRef {
  if (c === null) return { key: `${P}.credential.unknown` };
  if (c.kind === 'none') return { key: `${P}.credential.none` };
  return { key: `${P}.credential.${c.present ? 'present' : 'absent'}`, params: { kind: c.kind } };
}

function priceOf(p: RouteView['price']): TextRef {
  if (p === null) return { key: `${P}.price.unknown` };
  if (p.unit === 'money') return { key: `${P}.price.money`, params: { source: p.source } };
  return { key: `${P}.price.${p.unit}` };
}

function limitOf(l: RouteView['limit']): TextRef {
  if (l === null) return { key: `${P}.limit.unknown` };
  if (l.kind === 'slot') return { key: `${P}.limit.slot`, params: { slots: l.slots } };
  return { key: `${P}.limit.${l.kind}` };
}

export function routeLines(routes: readonly RouteView[]): RouteLine[] {
  return routes.map((r) => ({
    id: r.id,
    kind: r.kind,
    credential: credentialOf(r.credential),
    price: priceOf(r.price),
    limit: limitOf(r.limit),
    models: r.models === null ? null : r.models.map((m) => m.id),
    exhausted: r.exhausted,
  }));
}
