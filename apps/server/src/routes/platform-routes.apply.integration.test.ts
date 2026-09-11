import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Platform, PlatformApplyPlan, PlatformApplyResult } from '@agentdeck/contracts';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { writePlatform, writeToken } from '../domains/platform/store.ts';
import { PlatformGateway } from '../domains/platform/gateway/listener.ts';
import { registerPlatformRoutes } from './platform-routes.ts';

/**
 * Применение контура так, как его видит браузер.
 *
 * Живой слушатель шлюза здесь поднимается по-настоящему (на свободном порту):
 * готовность целей зависит от того, ПОДНЯТ ли он, и подменять этот ответ
 * заглушкой значило бы проверять не то, что работает у человека.
 *
 * Ключ контура при этом сохранён — и ни в одном ответе этих маршрутов его нет.
 */

/** Латиница обязательна: ключ вне печатного ASCII панель не сохраняет (Т12). */
const SECRET = 'CONTOUR-KEY-CORPORATE-4f21';

const PLATFORM: Platform = {
  id: 'enterprise-platform-dev',
  title: 'EnterprisePlatform · dev',
  driver: 'enterprise-platform',
  baseUrl: 'https://api.dev.example.ru',
  enabled: true,
  mode: 'required',
  budgetUsd: 0,
  capabilities: [],
  targets: ['assistant'],
  projectPaths: [],
  agents: [],
  budgetSince: '',
  caCertPath: '',
};

let root: string;
let appData: string;
let settingsPath: string;
let app: FastifyInstance;
let store: AppStore;
let gateway: PlatformGateway;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'cc-contour-apply-routes-'));
  appData = join(root, 'agentdeck');
  settingsPath = join(root, 'claude', 'settings.json');
  mkdirSync(appData, { recursive: true });
  mkdirSync(join(root, 'claude'), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify({ env: { EXISTING: 'keep-me' } }, null, 2));

  store = new AppStore(appData);
  writePlatform(store, PLATFORM);
  writeToken(appData, PLATFORM.id, SECRET);
  store.updateSettings({ platformGateway: { enabled: true, port: 0, forceStream: true } });

  gateway = new PlatformGateway();
  await gateway.start({ store, appDataDir: appData, port: 0 });

  app = Fastify();
  registerPlatformRoutes(
    app,
    {
      location: { paths: { root, appData, settings: settingsPath } },
      store,
      backupDir: join(root, 'backups'),
    } as unknown as ServerContext,
    gateway,
  );
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await gateway.stop();
  rmSync(root, { recursive: true, force: true });
});

const envOf = (): Record<string, string> =>
  (JSON.parse(readFileSync(settingsPath, 'utf8')) as { env: Record<string, string> }).env;

describe('GET /api/platforms/:id/apply', () => {
  it('предпросмотр не пишет ни одного файла и не отдаёт ключа', async () => {
    const before = readFileSync(settingsPath, 'utf8');
    const response = await app.inject({ url: '/api/platforms/enterprise-platform-dev/apply' });

    expect(response.statusCode).toBe(200);
    const plan = response.json<PlatformApplyPlan>();
    expect(plan.ready).toBe(true);
    expect(plan.profileId).toBe('contour-enterprise-platform-dev');
    expect(plan.targets[0]?.targetId).toBe('assistant');
    expect(response.body).not.toContain(SECRET);
    expect(readFileSync(settingsPath, 'utf8')).toBe(before);
  });

  it('контура нет — 404 с его идентификатором, а не пустой план', async () => {
    const response = await app.inject({ url: '/api/platforms/нет-такого/apply' });
    expect(response.statusCode).toBe(404);
    expect(response.json<{ code: string }>().code).toBe('platform_not_found');
  });
});

describe('POST /api/platforms/:id/apply', () => {
  it('пишет названные цели и не отдаёт ключа', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/platforms/enterprise-platform-dev/apply',
      payload: { targets: ['assistant', 'claude'], model: 'gpt-4o' },
    });

    expect(response.statusCode).toBe(200);
    const result = response.json<PlatformApplyResult>();
    expect(result.applied.map((item) => item.targetId)).toEqual(['assistant', 'claude']);
    expect(response.body).not.toContain(SECRET);

    const env = envOf();
    expect(env.EXISTING).toBe('keep-me');
    expect(env.ANTHROPIC_BASE_URL).toContain('/enterprise-platform-dev');
    expect(readFileSync(settingsPath, 'utf8')).not.toContain(SECRET);
    expect(store.getSettings().assistantEndpointId).toBe('contour-enterprise-platform-dev');
  });

  it('тело без списка целей — 400 с именем поля', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/platforms/enterprise-platform-dev/apply',
      payload: { targets: 'claude' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ detail: string }>().detail).toBe('targets');
  });
});

describe('POST /api/platforms/:id/disable', () => {
  it('возвращает файлы и удаляет профиль, а контур остаётся', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/platforms/enterprise-platform-dev/apply',
      payload: { targets: ['assistant', 'claude'] },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/platforms/enterprise-platform-dev/disable',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ profileRemoved: boolean }>().profileRemoved).toBe(true);

    expect(envOf()).toEqual({ EXISTING: 'keep-me' });
    expect(store.getSettings().endpointProfiles).toEqual([]);
    // Снимается применение, а не настройка: контур на месте и включён.
    expect(store.getSettings().platforms[0]?.id).toBe('enterprise-platform-dev');
  });

  it('со списком целей снимает точечно — строку журнала, а не всё разом', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/platforms/enterprise-platform-dev/apply',
      payload: { targets: ['assistant', 'claude'] },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/platforms/enterprise-platform-dev/disable',
      payload: { targets: ['claude'] },
    });

    expect(response.statusCode).toBe(200);
    const result = response.json<{
      entries: { targetId: string }[];
      profileRemoved: boolean;
    }>();
    expect(result.entries.map((item) => item.targetId)).toEqual(['claude']);
    expect(result.profileRemoved).toBe(false);
    // Ассистент остаётся на контуре: его никто не снимал.
    expect(envOf()).toEqual({ EXISTING: 'keep-me' });
    expect(store.getSettings().assistantEndpointId).toBe('contour-enterprise-platform-dev');
  });

  it('список целей не массивом — 400 с именем поля', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/platforms/enterprise-platform-dev/disable',
      payload: { targets: 'claude' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ detail: string }>().detail).toBe('targets');
  });
});

describe('DELETE /api/platforms/:id', () => {
  it('удаление контура снимает и применение — файлы не остаются с мёртвым адресом', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/platforms/enterprise-platform-dev/apply',
      payload: { targets: ['claude'] },
    });
    expect(envOf().ANTHROPIC_BASE_URL).toBeDefined();

    const response = await app.inject({ method: 'DELETE', url: '/api/platforms/enterprise-platform-dev' });
    expect(response.statusCode).toBe(200);
    expect(envOf()).toEqual({ EXISTING: 'keep-me' });
    expect(store.getPlatformApplied()['enterprise-platform-dev']).toBeUndefined();
    expect(store.getSettings().endpointProfiles).toEqual([]);
  });
});
