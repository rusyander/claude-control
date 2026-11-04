import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAdapterRegistry } from '../adapters/index.ts';
import { tempDir } from '../journal/__fixtures__/journal-harness.ts';
import type { CoreHomeLayout } from '../platform/core-home.ts';
import { buildLiveCoreRoutes, refreshRoutesNoted } from './core-routes.ts';
import { panelWiring } from './panel-wiring.ts';

/**
 * Пересборка маршрутов панели на живом ядре (s10 G7): контур, заведённый после загрузки,
 * становится маршрутом `gateway:<id>`, удалённый уходит, входы CLI остаются теми же экземплярами
 * (их состояние не теряется). Факты звена нового контура — его собственные (драйвер, манифест),
 * а не факты маршрута не из профилей. Набор с повторным id не подменяет прежний.
 */

const contour = (id: string) => ({
  id,
  title: `Контур ${id}`,
  driver: 'litellm',
  baseUrl: 'http://127.0.0.1:9',
  mode: 'required',
});

function writePanel(dir: string, ids: string[]): void {
  writeFileSync(
    join(dir, 'state.json'),
    JSON.stringify({ settings: { dlp: { enabled: false }, platforms: ids.map(contour) } }),
  );
}

function setup() {
  const dir = tempDir('routes-refresh-panel-');
  mkdirSync(dir, { recursive: true });
  writePanel(dir, ['c1']);
  const layout = { root: tempDir('routes-refresh-core-') } as CoreHomeLayout;
  const notes: Array<[string, Record<string, unknown>]> = [];
  const note = (event: string, data: Record<string, unknown>) => void notes.push([event, data]);
  const panel = panelWiring(layout, { panelAppData: dir, bootId: 'boot-1' }, note);
  const live = buildLiveCoreRoutes(
    createAdapterRegistry(),
    layout,
    undefined,
    undefined,
    panel.sources,
  );
  return { dir, panel, live, notes, note };
}

describe('s10 G7 core routes — panel routes rebuilt on a running core', () => {
  it('a contour added after boot becomes gateway:<id>, a removed one leaves, CLI login routes keep their instance', () => {
    const { dir, panel, live } = setup();
    const login = live.registry.get('cli-login:claude');
    expect(login).toBeDefined();
    expect(live.registry.get('gateway:c1')?.kind).toBe('gateway');
    expect(live.registry.get('gateway:c2')).toBeUndefined();
    writePanel(dir, ['c2']);
    expect(live.refreshPanel(panel.profilesNow())).toEqual({
      added: ['gateway:c2'],
      removed: ['gateway:c1'],
    });
    expect(live.registry.get('gateway:c2')?.kind).toBe('gateway');
    expect(live.registry.get('gateway:c1')).toBeUndefined();
    expect(live.registry.get('cli-login:claude')).toBe(login);
  });

  it('hop facts of a contour created after boot are its own (driver, manifest), not a non-panel route', () => {
    const { dir, panel } = setup();
    expect(panel.hopFactsOf('gateway:c2').manifest).toBeNull();
    writePanel(dir, ['c1', 'c2']);
    const facts = panel.hopFactsOf('gateway:c2');
    expect(facts.driver).not.toBeNull();
    expect(facts.manifest).not.toBeNull();
  });

  it('a set with a duplicate id keeps the previous set; the failure is noted, never thrown into the apply', () => {
    const { dir, panel, live, notes, note } = setup();
    writePanel(dir, ['c2']);
    refreshRoutesNoted(live.refreshPanel, panel.profilesNow(), note);
    expect(notes.find(([event]) => event === 'routes.refreshed')?.[1]).toEqual({
      added: ['gateway:c2'],
      removed: ['gateway:c1'],
    });
    const fresh = panel.profilesNow();
    const twice = { ...fresh, contours: [...fresh.contours, ...fresh.contours] };
    refreshRoutesNoted(live.refreshPanel, twice, note);
    const failed = notes.find(([event]) => event === 'routes.refresh-failed')?.[1];
    expect(String(failed?.reason)).toContain('duplicate route id gateway:c2');
    expect(live.registry.get('gateway:c2')?.kind).toBe('gateway');
  });
});
