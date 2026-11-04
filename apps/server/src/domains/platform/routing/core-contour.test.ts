import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Platform } from '@agentdeck/contracts';
import { defaultOurRules, defaultPlatformRules } from '@agentdeck/contracts/platform';
import { defaultPlatformTransport } from '@agentdeck/contracts/platform-transport';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import { writePlatform } from '../store/store.ts';
import { contourModelOf, coreContourRoutes, coreGatewayRouteId } from './core-contour.ts';

/**
 * Галочка потребителя контура → разрешённый набор задачи ядра (этап 10, F6): маршрут
 * `gateway:<id>` реестра ядра с моделью человека для потребителя. Шлюз, ключ и обязательный
 * контур судит ядро — здесь только перевод выбора человека.
 */

const PLATFORM: Platform = {
  id: 'company-dev',
  title: 'Company · dev',
  driver: 'enterprise-platform',
  baseUrl: 'https://api.dev.example.com',
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
  defaultModel: '',
  consumerModels: {},
  modelMap: {},
  rules: { platform: defaultPlatformRules(), ours: defaultOurRules() },
  caCertPath: '',
  transport: defaultPlatformTransport(),
};

let root: string;
let store: AppStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-core-contour-'));
  const dir = join(root, 'agentdeck');
  mkdirSync(dir, { recursive: true });
  store = new AppStore(dir);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const activate = (platform: Platform): void => {
  writePlatform(store, platform);
  store.updateSettings({ activePlatformId: platform.id });
};

describe('coreContourRoutes', () => {
  it('no active contour, or the consumer box is off in best-effort mode — no routes (core default set)', () => {
    expect(coreContourRoutes(store, 'tests', 'claude')).toBeUndefined();
    activate({ ...PLATFORM, mode: 'best-effort' });
    expect(coreContourRoutes(store, 'tests', 'claude')).toBeUndefined();
  });

  // Обязательный контур ядро всё равно сводит к шлюзу (L1, `contourNarrow`); без маршрута панели
  // шаблон модели оставался `*`, и снятая галочка роняла прогон отказом «needs a concrete model».
  it('required mode — the contour route for every consumer, box ticked or not, with the contour model', () => {
    activate({ ...PLATFORM, consumers: [], defaultModel: 'corp-large' });
    expect(coreContourRoutes(store, 'tests', 'claude')).toEqual([
      {
        adapter: 'claude',
        route: { kind: 'gateway', id: 'gateway:company-dev' },
        modelPattern: 'corp-large',
      },
    ]);
    expect(coreContourRoutes(store, 'foreign:qwen', 'qwen')?.[0]?.route.id).toBe(
      'gateway:company-dev',
    );
  });

  it('the tests box on — one gateway route of the active contour for the run adapter; no model = "*"', () => {
    activate({ ...PLATFORM, consumers: ['chat', 'tests'] });
    expect(coreContourRoutes(store, 'tests', 'qwen')).toEqual([
      { adapter: 'qwen', route: { kind: 'gateway', id: 'gateway:company-dev' }, modelPattern: '*' },
    ]);
    expect(coreGatewayRouteId('x')).toBe('gateway:x');
  });

  it('the consumer model (else the contour default) becomes the exact model pattern', () => {
    activate({
      ...PLATFORM,
      consumers: ['tests'],
      defaultModel: 'corp-large',
      consumerModels: { tests: 'corp-small' },
    });
    expect(coreContourRoutes(store, 'tests', 'claude')?.[0]?.modelPattern).toBe('corp-small');
    activate({ ...PLATFORM, consumers: ['tests'], defaultModel: 'corp-large' });
    expect(coreContourRoutes(store, 'tests', 'claude')?.[0]?.modelPattern).toBe('corp-large');
  });

  // s10 G7: модель, выбранная в чате, через обязательный контур — просьба. Без перевода шаблон
  // оставался моделью контура, а `set-model` слал имя вендора — ядро отказывало ход под чужим
  // шаблоном (`modelOn` → null).
  it('the chat pick goes through the contour map, else the contour model; contourModelOf names it', () => {
    activate({ ...PLATFORM, defaultModel: 'corp-large', modelMap: { opus: 'corp-xl' } });
    const mapped = coreContourRoutes(store, 'chat', 'claude', 'opus');
    expect(mapped?.[0]?.modelPattern).toBe('corp-xl');
    expect(contourModelOf(mapped)).toBe('corp-xl');
    // Имя, которого контур не знает, в шаблон не попадает — модель контура.
    expect(coreContourRoutes(store, 'chat', 'claude', 'claude-sonnet-5')?.[0]?.modelPattern).toBe(
      'corp-large',
    );
  });

  it('contourModelOf: no gateway route or a "*" pattern — no contour model', () => {
    expect(contourModelOf(undefined)).toBeUndefined();
    activate({ ...PLATFORM });
    expect(contourModelOf(coreContourRoutes(store, 'chat', 'claude'))).toBeUndefined();
    expect(
      contourModelOf([
        {
          adapter: 'claude',
          route: { kind: 'cli-login', id: 'cli-login:claude' },
          modelPattern: 'x',
        },
      ]),
    ).toBeUndefined();
  });
});
