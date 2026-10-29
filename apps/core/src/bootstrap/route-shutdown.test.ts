import type { ReleaseOutcome, Route, RouteRecorder } from '@agentdeck/contracts/core/routes';
import { describe, expect, it } from 'vitest';
import { createRouteRegistry } from '../routes/registry.ts';
import { shutdownRoutes } from './route-shutdown.ts';

/** Перебор реестра при чистой остановке: без имён маршрутов, отказ одного не держит остальных. */
function route(id: string, shutdown?: (record: RouteRecorder) => Promise<ReleaseOutcome>): Route {
  return { id, kind: 'stub', ...(shutdown ? { shutdown } : {}) } as unknown as Route;
}

describe('route shutdown on a clean core stop', () => {
  it('every route with shutdown is asked; a throwing one is a named leak and the next still releases', async () => {
    const notes: [string, Record<string, unknown>][] = [];
    const asked: string[] = [];
    const routes = createRouteRegistry([
      route('no-processes'),
      route('broken', async () => {
        asked.push('broken');
        throw new Error('stopTree refused');
      }),
      route('held', async (record) => {
        asked.push('held');
        await record.verified('r1', 'server stopped, port free');
        return { verified: [{ rid: 'r1', fact: 'server stopped, port free' }], leaks: [] };
      }),
    ]);
    const total = await shutdownRoutes(routes, (event, data) => notes.push([event, data]));
    expect(asked).toEqual(['broken', 'held']);
    expect(total).toEqual({
      verified: [{ rid: 'r1', fact: 'server stopped, port free' }],
      leaks: [{ rid: 'route:broken', reason: 'shutdown failed: stopTree refused' }],
    });
    expect(notes).toEqual([
      ['route.leak', { route: 'broken', rid: null, reason: 'shutdown failed: stopTree refused' }],
      ['route.released', { route: 'held', rid: 'r1', fact: 'server stopped, port free' }],
    ]);
  });
});
