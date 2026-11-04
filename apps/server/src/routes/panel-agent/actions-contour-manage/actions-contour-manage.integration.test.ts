import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import type { PlatformGatewayInfo, PlatformsInfo } from '@agentdeck/contracts';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../../context.ts';
import {
  createCoreGatewayView,
  type CoreGatewayView,
} from '../../../domains/platform/gateway-view/gateway-view.ts';
import {
  listeningGateway,
  memoryContours,
  type MemoryContours,
} from '../../../domains/platform/contours/__fixtures__/memory-contours.ts';
import { registerPlatformRoutes } from '../../platform-routes/platform-routes.ts';
import { HARNESS_ORIGIN, manageHarness, type ManageHarness } from '../manage-test-harness.ts';

/**
 * Контур сверх «составить и включить» — на настоящих маршрутах контура и стабе платформы
 * `tools/qa/stub-platform.mjs` как upstream пробы. Шлюз контуров держит ядро (этап 10, C3d):
 * панель видит его учёт (`memoryContours`, шлюз человека слушает на `GATEWAY_PORT`). Ключ вводит
 * «человек» маршрутом мастера; ни один ответ действия его не несёт. Доказательства —
 * `state.json` новым хранилищем, файл конфигурации CLI и ответы маршрута шлюза.
 */
const GATEWAY_PORT = 5_179;
const KEY = 'HUMAN-TYPED-CONTOUR-KEY-Mg4T';
const STUB = resolve(import.meta.dirname, '../../../../../../tools/qa/stub-platform.mjs');

interface Stub {
  url: string;
  calls: Array<{ path: string; body: string }>;
  close: () => Promise<void>;
}

describe('panel-agent actions: contour manage', () => {
  let root: string;
  let appData: string;
  let mcpConfig: string;
  let store: AppStore;
  let gateway: CoreGatewayView;
  let contours: MemoryContours;
  let stub: Stub;
  let h: ManageHarness;
  const results: string[] = [];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-agent-contour-x-'));
    appData = join(root, 'agentdeck');
    mkdirSync(appData, { recursive: true });
    mcpConfig = join(root, '.claude.json');
    writeFileSync(mcpConfig, '{}\n');
    store = new AppStore(appData);
    const module = (await import(pathToFileURL(STUB).href)) as {
      startStubPlatform: (options: { port: number }) => Promise<Stub>;
    };
    stub = await module.startStubPlatform({ port: 0 });
    results.length = 0;
    contours = memoryContours();
    contours.setUserGateway(listeningGateway(GATEWAY_PORT));
    gateway = createCoreGatewayView({ store, appDataDir: appData, contours });
    const ctx = {
      store,
      backupDir: join(root, 'backups'),
      location: {
        paths: { root, appData, settings: join(root, 'settings.json'), mcpConfig },
      },
    } as unknown as ServerContext;
    h = await manageHarness(ctx, (app) => registerPlatformRoutes(app, ctx, gateway));
  });

  afterEach(async () => {
    await h.close();
    await stub.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const call = async (name: string, input: unknown) => {
    const result = await h.call(name, input);
    results.push(JSON.stringify(result));
    return result;
  };
  const decided = async (name: string, input: unknown, decision?: 'approve' | 'reject') => {
    const out = await h.decided(name, input, decision);
    results.push(JSON.stringify(out));
    return out;
  };

  const disk = () => new AppStore(appData).getSettings();

  /** Контур `dev`: черновик агентом, ключ человеком, включение агентом. */
  const activeContour = async (): Promise<void> => {
    await decided('save_contour_draft', {
      baseUrl: `${stub.url}/v1`,
      id: 'dev',
      title: 'Dev stand',
      consumers: ['assistant'],
    });
    const info = (
      await h.app.inject({ method: 'GET', url: '/api/platforms' })
    ).json<PlatformsInfo>();
    const platform = info.platforms.find((status) => status.platform.id === 'dev')!.platform;
    const saved = await h.app.inject({
      method: 'PUT',
      url: '/api/platforms/dev',
      headers: { origin: HARNESS_ORIGIN },
      payload: { settings: platform, token: KEY },
    });
    expect(saved.statusCode).toBe(200);
    const { result } = await decided('enable_contour', { id: 'dev' });
    expect(result.outcome).toBe('done');
    expect(disk().activePlatformId).toBe('dev');
  };

  it('шлюз: состояние, включение карточкой, повторное — отказ, перепроверка — change', async () => {
    // Шлюз человека у ядра слушает и при выключенной настройке: держит его ядро, не панель.
    const status = await call('gateway_status', {});
    expect(status.outcome).toBe('done');
    expect(status.result).toMatchObject({ enabled: false, running: true, port: GATEWAY_PORT });

    const { card, result } = await decided('start_gateway', {});
    expect(card.risk).toBe('change');
    expect(result.outcome).toBe('done');
    expect(gateway.status().running).toBe(true);
    expect(disk().platformGateway.enabled).toBe(true);

    const again = await call('start_gateway', {});
    expect(again.outcome).toBe('failed');
    expect(again.message).toContain('already runs');
    expect(await h.pendingCards()).toEqual([]);

    const refreshes = contours.refreshes;
    const restart = await decided('restart_gateway', {});
    expect(restart.card.risk).toBe('change');
    expect(contours.refreshes).toBeGreaterThan(refreshes);
    expect(restart.result.outcome).toBe('done');
    expect(gateway.status().running).toBe(true);
    const live = (
      await h.app.inject({ method: 'GET', url: '/api/platforms/gateway' })
    ).json<PlatformGatewayInfo>();
    expect(restart.result.result).toMatchObject({ running: true, port: live.status.port });
  });

  it('шлюз ядра ждёт порт — включение карточкой кончается отказом, а не зелёным', async () => {
    contours.setUserGateway({
      ...listeningGateway(GATEWAY_PORT),
      state: 'waiting',
      lastError: 'EADDRINUSE',
    });
    const { result } = await decided('start_gateway', {});
    // Слова ядра (порт занят) — в ответе маршрута, его проверяет `platform-routes.integration`.
    expect(result).toMatchObject({ outcome: 'failed', status: 409 });
  });

  it('снять применение: карточка называет цель, откат снимает её; повтор — отказ до карточки', async () => {
    await activeContour();
    const assistantBefore = disk().assistantEndpointId;
    expect(assistantBefore).not.toBe('');

    const { card, result } = await decided('disable_contour', { id: 'dev' });
    expect(card.risk).toBe('danger');
    expect(card.preview.summaryCode).toBe('summary-disable-contour');
    expect(
      card.preview.fields.find((field) => field.labelCode === 'label-applied-targets')?.value,
    ).toMatch(/assistant|Ассистент/i);
    expect(result.outcome).toBe('done');
    // Контур остался и остался активным — снято только применение.
    expect(disk().activePlatformId).toBe('dev');
    expect(disk().assistantEndpointId).not.toBe(assistantBefore);

    const again = await call('disable_contour', { id: 'dev' });
    expect(again.outcome).toBe('failed');
    expect(again.message).toContain('not applied');
  }, 30_000);

  it('выключить: активный гаснет, тумблер выключен; повтор — «уже выключен»; отказ человека — ничего', async () => {
    await activeContour();
    const rejected = await decided('deactivate_contour', { id: 'dev' }, 'reject');
    expect(rejected.result.outcome).toBe('rejected');
    expect(disk().activePlatformId).toBe('dev');

    const { result } = await decided('deactivate_contour', { id: 'dev' });
    expect(result.outcome).toBe('done');
    expect(disk().activePlatformId).toBe('');
    expect(disk().platforms?.find((platform) => platform.id === 'dev')?.enabled).toBe(false);

    const again = await call('deactivate_contour', { id: 'dev' });
    expect(again.outcome).toBe('failed');
    expect(again.message).toContain('already off');
  }, 30_000);

  it('удалить: настройка и ключ уходят; незнакомый контур — отказ до карточки', async () => {
    await activeContour();
    const { card, result } = await decided('delete_contour', { id: 'dev' });
    expect(card.risk).toBe('danger');
    expect(card.preview.fields.map((field) => field.value)).toContain(`${stub.url}/v1`);
    expect(result.outcome).toBe('done');
    expect(result.result).toMatchObject({ deleted: 'dev', remaining: [] });
    expect(disk().platforms ?? []).toEqual([]);

    const missing = await call('delete_contour', { id: 'nope' });
    expect(missing.outcome).toBe('failed');
    expect(missing.message).toContain('No contour');
  }, 30_000);

  it('расход и «бюджет исчерпан»: отметка в учёте ядра видна агенту, агент снимает её карточкой', async () => {
    await activeContour();
    const clean = await call('contour_spend', { id: 'dev' });
    expect(clean.outcome).toBe('done');
    expect(clean.result).toMatchObject({ contour: 'dev', budget: { exhausted: false } });
    const nothing = await call('clear_contour_exhausted', { id: 'dev' });
    expect(nothing.outcome).toBe('failed');
    expect(nothing.message).toContain('not marked exhausted');

    // Отказ 402 контура ставит отметку в учёте звена ядра — так её и записываем; сам путь
    // «402 → отметка» — тест ядра `apps/core/src/hop-host/user-gateway.parity.integration.test.ts`
    // («402 ставит отметку исчерпания маршрута») и `spend.integration.test.ts` (P122).
    contours.record({ platformId: 'dev', exhausted: { at: new Date().toISOString() } });
    const marked = await call('contour_spend', { id: 'dev' });
    expect(marked.result).toMatchObject({ budget: { exhausted: true } });

    const { card, result } = await decided('clear_contour_exhausted', { id: 'dev' });
    expect(card.preview.summaryCode).toBe('summary-clear-contour-exhausted');
    expect(result.outcome).toBe('done');
    expect(result.result).toMatchObject({ cleared: true, exhausted: false });
    // Снимает звено ядра (C3b): панель передала нажатие, отметки в учёте больше нет.
    expect(contours.cleared).toEqual(['dev']);
    expect(contours.records().dev?.exhaustedAt).toBeUndefined();

    expect((await call('contour_spend', { id: 'nope' })).outcome).toBe('failed');
  }, 30_000);

  it('MCP контура: подключение пишет запись без ключа в конфиг CLI, отключение убирает; повтор — отказ', async () => {
    await activeContour();
    const { card, result } = await decided('contour_mcp_connect', { connect: true });
    expect(card.preview.summaryCode).toBe('summary-contour-mcp-connect');
    expect(result.outcome).toBe('done');
    const written = readFileSync(mcpConfig, 'utf8');
    expect(Object.keys((JSON.parse(written) as { mcpServers: object }).mcpServers)).toHaveLength(1);
    expect(written).not.toContain(KEY);

    const again = await call('contour_mcp_connect', { connect: true });
    expect(again.outcome).toBe('failed');
    expect(again.message).toContain('already connected');

    await decided('contour_mcp_connect', { connect: false });
    const after = JSON.parse(readFileSync(mcpConfig, 'utf8')) as { mcpServers?: object };
    expect(Object.keys(after.mcpServers ?? {})).toHaveLength(0);
  }, 30_000);

  it('ключ контура не появляется ни в одном ответе действия', async () => {
    await activeContour();
    await call('gateway_status', {});
    await call('contour_spend', { id: 'dev' });
    await decided('disable_contour', { id: 'dev' });
    const all = results.join('\n');
    expect(all).not.toContain(KEY);
    expect(all).not.toContain(KEY.slice(-4));
  }, 30_000);
});
