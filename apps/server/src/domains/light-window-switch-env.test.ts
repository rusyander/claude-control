import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppStore } from '../lib/app-store.ts';
import { resolveHelperRoute } from './assistant-route.ts';
import { resolvePanelAgentLaunch } from './panel-agent/launch.ts';

/**
 * Лёгкие окна панели (помощники, агент панели) запускают `claude` без слоя
 * `user`, а переключатель «Claude Code на локальной модели» живёт в settings.json.
 * Живой прогон 08.10: при включённом переключателе оба окна ушли в облако и
 * получили «Not logged in». Маршрут обязан нести окружение переключателя сам.
 */

const SWITCH = { ANTHROPIC_BASE_URL: 'http://127.0.0.1:11435', ANTHROPIC_MODEL: 'qwen' };

describe('окно без слоя user при уведённом Claude', () => {
  let appData: string;
  let store: AppStore;

  beforeEach(() => {
    appData = mkdtempSync(join(tmpdir(), 'cc-light-switch-'));
    store = new AppStore(appData);
    store.updateSettings({ provider: 'claude' });
  });
  afterEach(() => rmSync(appData, { recursive: true, force: true }));

  const base = () => ({ store, appDataDir: appData, gatewayPort: () => 0 });

  it('помощник: маршрут claude несёт окружение переключателя', () => {
    const route = resolveHelperRoute({
      ...base(),
      runRoute: () => ({ env: {} }) as never,
      claudeSwitchEnv: () => SWITCH,
    });
    expect(route).toMatchObject({ kind: 'claude', env: SWITCH });
  });

  it('помощник: переключатель выключен — окружение пустое, прежний путь', () => {
    const route = resolveHelperRoute({ ...base(), runRoute: () => ({ env: {} }) as never });
    expect(route).toMatchObject({ kind: 'claude', env: {} });
  });

  it('агент панели без профиля: Claude идёт туда же, куда уведён переключателем', () => {
    const launch = resolvePanelAgentLaunch({
      ...base(),
      detect: () => true,
      claudeSwitchEnv: () => SWITCH,
    });
    expect(launch).toMatchObject({ ok: true, dialect: 'claude', env: SWITCH });
  });

  it('агент панели на чужом CLI окружение Claude не подхватывает', () => {
    store.updateSettings({ provider: 'qwen' });
    const launch = resolvePanelAgentLaunch({
      ...base(),
      detect: () => true,
      claudeSwitchEnv: () => SWITCH,
    });
    expect(launch).toMatchObject({ ok: true, env: {} });
  });
});
