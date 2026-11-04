import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setStoredKey } from '@agentdeck/keys/provider-keys';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../journal/__fixtures__/journal-harness.ts';
import { bootCore, type BootedCore } from './boot.ts';
import { panelAppDataDir, readPanelProfiles } from './panel-profiles.ts';
import { contourManifest, contourUpstreamDialect, routeHopFacts } from './panel-routes.ts';

/**
 * Маршруты ключа API и контуров на НАСТОЯЩЕЙ загрузке ядра (W2b): профили — из каталога данных
 * панели (временный, только чтение), наличие ключа — из её настоящего зашифрованного хранилища
 * (`keyPresencePort`). Ключ есть у профиля адреса — `present: true`; у контура ключа нет — `false`.
 */

const booted: BootedCore[] = [];
afterEach(async () => {
  for (const core of booted.splice(0)) await core.stop();
});

function panelData(state: unknown): string {
  const dir = tempDir('panel-data-');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
  return dir;
}

const STATE = {
  settings: {
    dlp: { enabled: false },
    endpointProfiles: [
      { id: 'own-1', name: 'Свой', baseUrl: 'http://127.0.0.1:9/v1', apiKind: 'openai-compat' },
      // Профиль контура — маршрут `gateway:`, второго через шлюз панели нет.
      {
        id: 'contour-c1',
        baseUrl: 'http://127.0.0.1:9',
        apiKind: 'anthropic',
        ownerPlatformId: 'c1',
      },
      { id: 'broken', apiKind: 'anthropic' },
    ],
    platforms: [
      { id: 'c1', title: 'Контур', driver: 'litellm', baseUrl: 'http://127.0.0.1:9' },
      {
        id: 'c2',
        title: 'Контур 2',
        driver: 'litellm',
        baseUrl: 'http://127.0.0.1:9',
        dataMask: false,
      },
      { id: 'bad id!', title: 'x', driver: 'litellm', baseUrl: 'x' },
      // Платформа компании объявляет подмену данных: без выбора карточки маска ВКЛЮЧЕНА.
      { id: 'c3', title: 'Компания', driver: 'enterprise-platform', baseUrl: 'http://127.0.0.1:9' },
      // Azure: ключ в `api-key` без слова (пресет), версия API параметром адреса.
      {
        id: 'c4',
        title: 'Azure',
        driver: 'azure-openai',
        baseUrl: 'http://127.0.0.1:9/openai/v1?api-version=preview',
        transport: { query: 'deployment=d1', headers: 'X-Tenant: t1' },
      },
      // Свой заголовок карточки и режим версии `as-is`: корень без `/v1`.
      {
        id: 'c5',
        title: 'Свой заголовок',
        driver: 'litellm',
        baseUrl: 'http://127.0.0.1:9/gw',
        transport: { authHeader: 'X-Auth', authScheme: 'Token', version: 'as-is' },
      },
    ],
  },
};

async function boot(panelAppData: string | null): Promise<BootedCore> {
  const core = await bootCore({
    home: join(tempDir('core-panel-'), 'core'),
    build: 'panel-routes-test',
    panelAppData,
    loop: false,
  });
  booted.push(core);
  return core;
}

describe('boot: api-key and gateway routes from the panel app data (W2b)', () => {
  it('key present → present:true, absent → false, through the booted registry', async () => {
    const appData = panelData(STATE);
    setStoredKey(appData, 'endpoint:own-1', 'sk-test-panel-routes-0001');
    const core = await boot(appData);
    const own = core.routes.get('api-key:endpoint:own-1');
    const contour = core.routes.get('gateway:c1');
    expect(own && contour).toBeTruthy();
    expect(await own!.read.credential()).toEqual({
      value: { kind: 'hop-injected', present: true },
    });
    expect(await contour!.read.credential()).toEqual({
      value: { kind: 'hop-injected', present: false },
    });
    // Профиль, порождённый контуром, и негодные записи маршрутов не дают.
    expect(core.routes.get('api-key:endpoint:contour-c1')).toBeUndefined();
    expect(core.routes.get('api-key:endpoint:broken')).toBeUndefined();
    expect(core.routes.get('gateway:c2')).toBeTruthy();
  });

  it('no panel app data → no api-key/gateway routes; the CLI login routes stay', async () => {
    const core = await boot(null);
    const ids = core.routes.list().map((r) => r.id);
    expect(ids.some((id) => id.startsWith('api-key:') || id.startsWith('gateway:'))).toBe(false);
    expect(ids).toContain('cli-login:claude');
  });

  it('unreadable records are named; DLP policy: global switch, contour choice, unset → the driver declaration', () => {
    const profiles = readPanelProfiles(panelData(STATE));
    expect(profiles.problems).toEqual([
      'endpointProfiles[2] (broken): name unreadable',
      expect.stringMatching(/^platforms\[2\] \(bad id!\): id unreadable$/),
    ]);
    // Пресет карточки (`litellm`) сведён к драйверу базы, который знает звено; совместимый шлюз
    // подмены данных не объявляет — без выбора карточки маски нет (как `dataMaskOn` панели).
    expect(routeHopFacts(profiles, 'gateway:c1')).toEqual({
      driver: 'openai-compat',
      dlpRequired: false,
      upstreamAuth: { header: 'authorization', scheme: 'Bearer' },
      upstreamHeaders: {},
      upstreamQuery: {},
      upstreamRooted: true,
      // Объявленное пресетом едет к звену: база его не знает.
      manifest: { anthropicMessages: 'messages' },
      // Правила тела верха (этап 10, C3): совместимому шлюзу полей не ставится; перевод в поток —
      // общая настройка `platformGateway.forceStream`, без записи «да», как у шлюза панели прежде.
      requestRules: { forceStream: true, set: [], streamless: [] },
    });
    expect(routeHopFacts(profiles, 'gateway:c2').dlpRequired).toBe(false);
    expect(routeHopFacts(profiles, 'api-key:endpoint:own-1').manifest).toBeNull();
    expect(routeHopFacts(profiles, 'gateway:c3')).toMatchObject({
      driver: 'enterprise-platform',
      dlpRequired: true,
    });
    expect(routeHopFacts(profiles, 'api-key:endpoint:own-1').dlpRequired).toBe(false);
    const on = readPanelProfiles(
      panelData({ settings: { ...STATE.settings, dlp: { enabled: true } } }),
    );
    expect(routeHopFacts(on, 'gateway:c2').dlpRequired).toBe(true);
    expect(routeHopFacts(on, 'api-key:endpoint:own-1').dlpRequired).toBe(true);
    expect(routeHopFacts(on, 'cli-login:claude').dlpRequired).toBe(false);
  });

  it('contour transport reaches the hop facts: preset auth, own header, fixed headers, query, version root', async () => {
    const appData = panelData(STATE);
    const profiles = readPanelProfiles(appData);
    expect(routeHopFacts(profiles, 'gateway:c4')).toMatchObject({
      upstreamAuth: { header: 'api-key', scheme: '' },
      upstreamHeaders: { 'x-tenant': 't1' },
      upstreamQuery: { 'api-version': 'preview', deployment: 'd1' },
      upstreamRooted: true,
    });
    expect(routeHopFacts(profiles, 'gateway:c5').upstreamAuth).toEqual({
      header: 'x-auth',
      scheme: 'Token',
    });
    // Корень аренды — тем же правилом версии, что у панели: `auto` дописал `/v1`, `as-is` — нет.
    const core = await boot(appData);
    const rootOf = async (id: string): Promise<string | undefined> => {
      const route = core.routes.get(id)!;
      const lease = { leaseId: 'l', routeId: id } as never;
      return (await route.endpoint(lease, { record: () => undefined } as never))?.baseUrl;
    };
    expect(await rootOf('gateway:c4')).toBe('http://127.0.0.1:9/openai/v1');
    expect(await rootOf('gateway:c5')).toBe('http://127.0.0.1:9/gw');
    expect(await rootOf('gateway:c1')).toBe('http://127.0.0.1:9/v1');
    // Ключ вендора с адресом из фактов запуска — свой маршрут `api-key:<cli>`.
    expect(core.routes.get('api-key:claude')).toBeTruthy();
    expect(routeHopFacts(profiles, 'api-key:gemini').upstreamAuth).toEqual({
      header: 'x-goog-api-key',
      scheme: '',
    });
  });

  it('contour upstream dialect: a declared native Anthropic endpoint goes without the bridge; the card tool shim beats it unless the contour has its own tools', () => {
    const card = (over: Record<string, unknown>) =>
      ({ id: 'x', driver: 'openrouter', ...over }) as never;
    const tools = (platformTools: string[]) => ({ platform: { platformTools } }) as never;
    expect(contourManifest(card({}))).toEqual({ anthropicMessages: 'messages' });
    expect(contourUpstreamDialect(card({}))).toBe('anthropic-messages');
    expect(contourUpstreamDialect(card({ driver: 'openai-compat' }))).toBe('openai-chat');
    expect(contourUpstreamDialect(card({ manifest: { anthropicMessages: '' } }))).toBe(
      'openai-chat',
    );
    expect(contourUpstreamDialect(card({ toolShim: true, rules: tools([]) }))).toBe('openai-chat');
    expect(contourUpstreamDialect(card({ toolShim: true, rules: tools(['search']) }))).toBe(
      'anthropic-messages',
    );
  });

  it('panel app-data dir: explicit variable; moved core home → none; else the panel rule, no move', () => {
    const home = tempDir('panel-home-');
    expect(panelAppDataDir({ AGENTDECK_PANEL_DATA: '/x/data' }, home)).toBe('/x/data');
    expect(panelAppDataDir({ AGENTDECK_CORE_HOME: '/stand/core' }, home)).toBeUndefined();
    expect(
      panelAppDataDir(
        { AGENTDECK_CORE_HOME: '/stand/core', AGENTDECK_PANEL_DATA: '/x/data' },
        home,
      ),
    ).toBe('/x/data');
    expect(panelAppDataDir({}, home)).toBeUndefined();
    const standalone = join(home, '.agentdeck', 'data');
    mkdirSync(standalone, { recursive: true });
    writeFileSync(join(standalone, 'state.json'), '{}');
    expect(panelAppDataDir({}, home)).toBe(standalone);
    const legacy = join(home, '.claude', ['claude', 'control'].join('-'));
    mkdirSync(legacy, { recursive: true });
    expect(panelAppDataDir({}, home)).toBe(legacy);
    mkdirSync(join(home, '.claude', 'agentdeck'));
    expect(panelAppDataDir({}, home)).toBe(join(home, '.claude', 'agentdeck'));
    expect(panelAppDataDir({ CLAUDE_CONFIG_DIR: join(home, 'cfg') }, home)).toBe(standalone);
  });
});
