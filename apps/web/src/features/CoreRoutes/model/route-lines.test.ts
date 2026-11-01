import { describe, expect, it } from 'vitest';
import type { RouteView } from '@agentdeck/contracts/core/panel-api';
import type { RouteCaps } from '@agentdeck/contracts/core/routes';
import { routeLines } from './routeLines';

/**
 * Строки маршрутов ядра на экране запуска: доступ — только вид и наличие, непрочитанный факт —
 * «не прочитан», исчерпание видно.
 */

const CAPS: RouteCaps = {
  dialects: [],
  tools: true,
  images: false,
  streaming: true,
  maskable: false,
  offline: false,
  binding: { via: 'endpoint' },
  limitsToTell: false,
};

const ROUTES: RouteView[] = [
  {
    id: 'cli-login:claude',
    kind: 'cli-login',
    credential: { kind: 'cli-store', present: true },
    price: { unit: 'window' },
    limit: { kind: 'window', source: 'in-band-event' },
    models: [{ id: 'opus' }, { id: 'sonnet' }],
    exhausted: false,
    caps: CAPS,
  },
  {
    id: 'api-key:vendor',
    kind: 'api-key',
    credential: { kind: 'env', present: false },
    price: { unit: 'money', source: 'pricing-2026-10' },
    limit: { kind: 'budget' },
    models: null,
    exhausted: true,
    caps: CAPS,
  },
  {
    id: 'local:own',
    kind: 'local',
    credential: { kind: 'none', present: true },
    price: null,
    limit: { kind: 'slot', slots: 2 },
    models: [],
    exhausted: false,
    caps: CAPS,
  },
];

describe('core routes lines', () => {
  it('maps every route fact to a text key; unknown stays unknown, never no', () => {
    const lines = routeLines(ROUTES);
    expect(lines.map((l) => [l.credential, l.price, l.limit])).toEqual([
      [
        { key: 'coreLaunch.routes.credential.present', params: { kind: 'cli-store' } },
        { key: 'coreLaunch.routes.price.window' },
        { key: 'coreLaunch.routes.limit.window' },
      ],
      [
        { key: 'coreLaunch.routes.credential.absent', params: { kind: 'env' } },
        { key: 'coreLaunch.routes.price.money', params: { source: 'pricing-2026-10' } },
        { key: 'coreLaunch.routes.limit.budget' },
      ],
      [
        { key: 'coreLaunch.routes.credential.none' },
        { key: 'coreLaunch.routes.price.unknown' },
        { key: 'coreLaunch.routes.limit.slot', params: { slots: 2 } },
      ],
    ]);
    expect(lines.map((l) => l.models)).toEqual([['opus', 'sonnet'], null, []]);
    expect(lines.map((l) => l.exhausted)).toEqual([false, true, false]);
  });
});
