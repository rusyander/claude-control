import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerContext } from '../../context.ts';
import { AppStore } from '../../lib/app-store/app-store.ts';
import { backgroundWatcherDeps } from './watcher.ts';

/**
 * Сборка сервера отдаёт наблюдателю маршрут разбора. Без этой строки решение
 * `route.ts` было бы нарисованным: домен его умеет, а живая панель разбирала бы
 * в облаке Claude при любом активном CLI. Хранилище настоящее, во временной папке.
 */
describe('сборка наблюдателя — маршрут разбора', () => {
  let appData: string;
  let store: AppStore;

  beforeEach(() => {
    appData = mkdtempSync(join(tmpdir(), 'cc-watch-boot-'));
    store = new AppStore(appData);
  });
  afterEach(() => rmSync(appData, { recursive: true, force: true }));

  const deps = () =>
    backgroundWatcherDeps(
      { store, location: { paths: { appData } }, pricing: {} } as unknown as ServerContext,
      () => 0,
    );

  it('активен чужой CLI, маршрут в облако Claude — отказ кодом с именем CLI', () => {
    store.updateSettings({ provider: 'qwen' });
    expect(deps().resolveRoute?.()).toMatchObject({
      ok: false,
      messageCode: 'watcher-provider-unsupported',
      params: { provider: 'Qwen Code' },
    });
  });

  it('активен Claude без профиля — облако вендора, как раньше', () => {
    store.updateSettings({ provider: 'claude' });
    expect(deps().resolveRoute?.()).toEqual({ ok: true, env: {}, viaContour: false });
  });
});
