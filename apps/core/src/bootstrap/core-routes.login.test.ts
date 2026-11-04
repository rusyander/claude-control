import { describe, expect, it } from 'vitest';
import { createAdapterRegistry, type AdapterRegistry, type CliAdapter } from '../adapters/index.ts';
import type { CoreHomeLayout } from '../platform/core-home.ts';
import { buildCoreRoutes } from './core-routes.ts';

/**
 * Маршрут входа CLI строится только переходнику, чей запуск его примет: заготовка
 * (`built: false`) и переходник «только по адресу модели» (`cliLogin: false`, Codex — его вход в
 * доме человека, сеанс его не читает) маршрута не получают. Иначе набор по умолчанию каждой задачи
 * предлагал бы маршрут, который запуск всегда отказывает.
 */

const layout = { root: '/core-home' } as CoreHomeLayout;

const fake = (adapters: Partial<CliAdapter>[]): AdapterRegistry => ({
  get: (id) => adapters.find((a) => a.id === id) as CliAdapter | undefined,
  ids: () => adapters.map((a) => a.id as string),
  all: () => adapters as CliAdapter[],
});

describe('core routes — a CLI-login route only where the launch takes it', () => {
  it('a plain adapter gets cli-login; a placeholder and a cliLogin:false adapter get none', () => {
    const routes = buildCoreRoutes(
      fake([{ id: 'a' }, { id: 'b', built: false }, { id: 'c', cliLogin: false }]),
      layout,
      undefined,
    );
    expect(routes.list().map((r) => r.id)).toEqual(['cli-login:a']);
  });

  it('the real registry: codex declares cliLogin:false and has no cli-login route', () => {
    const registry = createAdapterRegistry();
    expect(registry.get('codex')?.cliLogin).toBe(false);
    const ids = buildCoreRoutes(registry, layout, undefined)
      .list()
      .map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining(['cli-login:claude', 'cli-login:qwen']));
    expect(ids).not.toContain('cli-login:codex');
  });
});
