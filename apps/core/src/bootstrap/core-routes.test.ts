import type { RouteRecorder } from '@agentdeck/contracts/core/routes';
import { describe, expect, it, vi } from 'vitest';
import { createAdapterRegistry } from '../adapters/index.ts';
import type { CoreHomeLayout } from '../platform/core-home.ts';
import { buildCoreRoutes } from './core-routes.ts';

/**
 * Проводка своей модели при загрузке ядра (11 R:PR-04): маршрут получает `bootId` ядра — по нему
 * следующее ядро узнаёт место упавшего — и журнал ядра для решений вне аренды задачи. Поведение
 * маршрута с этими полями — в `routes/local/own/own.waiters.integration.test.ts`; здесь — что
 * загрузка их передаёт.
 */

const seen = vi.hoisted(() => ({ options: [] as unknown[] }));
vi.mock('../routes/local/own/own.ts', () => ({
  createOwnRoute: (options: unknown) => {
    seen.options.push(options);
    return { id: 'local:own', caps: {}, shutdown: async () => ({ verified: [], leaks: [] }) };
  },
}));

const layout = { root: '/core-home' } as CoreHomeLayout;
const localOwn = {
  server: { command: 'llama-server' },
  models: [{ id: 'm', path: '/m.gguf', sizeBytes: 1 }],
};
const journal: RouteRecorder = {
  decision: () => undefined,
  created: () => undefined,
  verified: () => undefined,
  leak: () => undefined,
};

describe('P10 core routes — own model wiring at boot', () => {
  it('P10 buildCoreRoutes hands the own route this core’s bootId and the core journal; without them the route gets neither', () => {
    seen.options.length = 0;
    buildCoreRoutes(createAdapterRegistry(), layout, { localOwn }, { bootId: 'boot-1', journal });
    buildCoreRoutes(createAdapterRegistry(), layout, { localOwn });
    const [wired, bare] = seen.options as Record<string, unknown>[];
    expect(wired).toMatchObject({ core: { bootId: 'boot-1' }, journal });
    expect(bare).not.toHaveProperty('core');
    expect(bare).not.toHaveProperty('journal');
  });
});
