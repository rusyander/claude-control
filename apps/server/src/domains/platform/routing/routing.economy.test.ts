import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { defaultOurRules, defaultPlatformRules } from '@agentdeck/contracts/platform';
import { defaultPlatformTransport } from '@agentdeck/contracts/platform-transport';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Platform, PlatformHealthRecord } from '@agentdeck/contracts';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import { writePlatform, writeToken } from '../store/store.ts';
import { resolveRunRoute, runRouteOf, type PlatformRoutingDeps } from './routing.ts';

/**
 * Что маршрут отдаёт рычагам экономии (пакет K): строки карты моделей (n6 —
 * доставка на Sonnet только там, где контур знает «sonnet») и окно модели по
 * каталогу (n1 — окно сжатия группы не выше него). Проекция `runRouteOf` —
 * та же, что получает место спавна, поэтому проверяется вместе с решением.
 */

const PLATFORM: Platform = {
  id: 'company-dev',
  title: 'Company · dev',
  driver: 'enterprise-platform',
  baseUrl: 'https://api.dev.example.ru',
  enabled: true,
  mode: 'required',
  budgetUsd: 0,
  capabilities: [],
  targets: [],
  consumers: ['chat'],
  projectPaths: [],
  agents: [],
  budgetSince: '',
  toolShim: true,
  contourPrompt: true,
  defaultModel: 'company-mid',
  consumerModels: {},
  modelMap: {},
  rules: { platform: defaultPlatformRules(), ours: defaultOurRules() },
  caCertPath: '',
  transport: defaultPlatformTransport(),
};

const health = (models: { id: string; contextLimit?: number }[]): PlatformHealthRecord => ({
  outcome: 'ok',
  reachable: true,
  url: 'https://api.dev.example.ru/v1/models',
  detail: '',
  models,
  capabilities: [],
  limits: {},
  notes: [],
  compromises: [],
  checkedAt: '2026-09-12T10:00:00.000Z',
});

let root: string;
let dir: string;
let store: AppStore;
let deps: PlatformRoutingDeps;

function connect(platform: Platform = PLATFORM): void {
  writePlatform(store, platform);
  writeToken(dir, platform.id, 'CONTOUR-KEY-TEST');
  store.updateSettings({ activePlatformId: platform.id });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-contour-economy-'));
  dir = join(root, 'agentdeck');
  mkdirSync(dir, { recursive: true });
  store = new AppStore(dir);
  deps = { store, appDataDir: dir, gatewayPort: () => 5179 };
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('маршрут контура для рычагов экономии', () => {
  it('ключи карты моделей — строчными, без пустых строк и без строк без цели', () => {
    connect({ ...PLATFORM, modelMap: { ' Sonnet ': 'company-small', opus: '', '': 'x' } });
    const route = runRouteOf(resolveRunRoute(deps, 'chat'));
    expect(route.modelMapKeys).toEqual(['sonnet']);
  });

  it('пустая карта — поля нет вовсе', () => {
    connect();
    expect(runRouteOf(resolveRunRoute(deps, 'chat')).modelMapKeys).toBeUndefined();
  });

  it('окно модели прогона берётся из каталога; модели там нет — поля нет', () => {
    connect();
    store.savePlatformHealth(
      PLATFORM.id,
      health([
        { id: 'company-mid', contextLimit: 131_072 },
        { id: 'company-large', contextLimit: 1_000_000 },
      ]),
    );
    expect(runRouteOf(resolveRunRoute(deps, 'chat')).modelContext).toBe(131_072);
    store.savePlatformHealth(PLATFORM.id, health([{ id: 'company-large', contextLimit: 9 }]));
    expect(runRouteOf(resolveRunRoute(deps, 'chat')).modelContext).toBeUndefined();
  });

  it('мимо контура маршрут пуст — ни карты, ни окна', () => {
    expect(runRouteOf(resolveRunRoute(deps, 'chat'))).toEqual({ env: {} });
  });
});
