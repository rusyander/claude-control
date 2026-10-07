import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { defaultOurRules, defaultPlatformRules } from '@agentdeck/contracts/platform';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Platform } from '@agentdeck/contracts';
import { defaultPlatformTransport } from '@agentdeck/contracts/platform-transport';
import { AppStore } from '../../lib/app-store.ts';
import { gooseConfigDir, kimiCodeHome } from '../../providers/catalog/config-dirs.ts';
import { writePlatform, writeToken } from './store.ts';
import {
  describeRunPlan,
  localClaudeRun,
  listConsumerOptions,
  resolveRunRoute,
  type PlatformRoutingDeps,
} from './routing.ts';

/**
 * Контур окружением ОДНОГО прогона (`runEndpoint`, X7): Kimi Code, Goose и
 * OpenCode. Переменных адреса в реестре у них нет, файловой цели тоже, а
 * задокументированное окружение перебивает конфиг человека.
 *
 * Здесь — решение маршрута. Что настоящий CLI с этим окружением идёт в шлюз, а
 * не к провайдеру из конфига, доказывает только живой прогон
 * (`tools/qa/check-run-endpoint-cli.mjs`).
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
  consumers: ['foreign:kimi', 'foreign:goose', 'foreign:opencode'],
  projectPaths: [],
  agents: [],
  budgetSince: '',
  toolShim: true,
  contourPrompt: true,
  defaultModel: 'Qwen/Qwen3.8-27B',
  consumerModels: {},
  modelMap: {},
  rules: { platform: defaultPlatformRules(), ours: defaultOurRules() },
  caCertPath: '',
  transport: defaultPlatformTransport(),
};

const BASE = 'http://127.0.0.1:5179/company-dev/_s/foreign';

let root: string;
let dir: string;
let deps: PlatformRoutingDeps;
let store: AppStore;

function connect(platform: Platform = PLATFORM): void {
  writePlatform(store, platform);
  writeToken(dir, platform.id, 'CONTOUR-KEY-4f21');
  store.updateSettings({ activePlatformId: platform.id });
}

function writeConfig(file: string, text: string): void {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text, 'utf8');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-run-endpoint-'));
  dir = join(root, 'agentdeck');
  mkdirSync(dir, { recursive: true });
  // Конфиги CLI — временные: Kimi по своей переменной, Goose — по каталогу ОС.
  vi.stubEnv('KIMI_CODE_HOME', join(root, 'kimi-home'));
  vi.stubEnv('APPDATA', join(root, 'appdata'));
  vi.stubEnv('HOME', join(root, 'home'));
  // Gemini читает способ входа из `~/.gemini` (на Windows дом — USERPROFILE) и
  // из системных настроек — всё во временном.
  vi.stubEnv('USERPROFILE', join(root, 'home'));
  vi.stubEnv('GEMINI_CLI_SYSTEM_SETTINGS_PATH', join(root, 'gemini-system', 'settings.json'));
  vi.stubEnv('GEMINI_CLI_SYSTEM_DEFAULTS_PATH', join(root, 'gemini-system', 'defaults.json'));
  store = new AppStore(dir);
  deps = { store, appDataDir: dir, gatewayPort: () => 5179 };
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('контур окружением прогона', () => {
  it('Kimi: модель целиком из KIMI_MODEL_*, адрес шлюза с /v1, ключ — заглушка', () => {
    connect();
    const decision = resolveRunRoute(deps, 'foreign:kimi', '', 'run-1');
    expect(decision.routed).toBe(true);
    if (!decision.routed) return;
    expect(decision.env).toEqual({
      KIMI_MODEL_PROVIDER_TYPE: 'openai',
      KIMI_MODEL_BASE_URL: `${BASE}/kimi/_run/run-1/v1`,
      KIMI_MODEL_API_KEY: expect.not.stringContaining('CONTOUR-KEY'),
      KIMI_MODEL_NAME: 'Qwen/Qwen3.8-27B',
    });
  });

  it('Goose: хост и путь порознь, путь без ведущей косой черты, субагенты тем же провайдером', () => {
    connect();
    const decision = resolveRunRoute(deps, 'foreign:goose');
    expect(decision.routed).toBe(true);
    if (!decision.routed) return;
    expect(decision.env.GOOSE_PROVIDER).toBe('openai');
    expect(decision.env.GOOSE_MODEL).toBe('Qwen/Qwen3.8-27B');
    expect(decision.env.GOOSE_SUBAGENT_PROVIDER).toBe('openai');
    expect(decision.env.GOOSE_SUBAGENT_MODEL).toBe('Qwen/Qwen3.8-27B');
    expect(decision.env.OPENAI_HOST).toBe('http://127.0.0.1:5179');
    expect(decision.env.OPENAI_BASE_PATH).toBe('company-dev/_s/foreign/goose/v1/chat/completions');
    expect(decision.env.OPENAI_API_KEY).not.toContain('CONTOUR-KEY');
  });

  it('OpenCode: единственный разрешённый провайдер — контур, и на него смотрят все агенты', () => {
    connect();
    const decision = resolveRunRoute(deps, 'foreign:opencode');
    expect(decision.routed).toBe(true);
    if (!decision.routed) return;
    const config = JSON.parse(decision.env.OPENCODE_CONFIG_CONTENT ?? '{}');
    const ref = 'contour/Qwen/Qwen3.8-27B';
    expect(config.enabled_providers).toEqual(['contour']);
    expect(config.provider.contour.options.baseURL).toBe(`${BASE}/opencode/v1`);
    expect(config.provider.contour.options.apiKey).not.toContain('CONTOUR-KEY');
    expect(Object.keys(config.provider.contour.models)).toEqual(['Qwen/Qwen3.8-27B']);
    expect(config.model).toBe(ref);
    expect(config.small_model).toBe(ref);
    for (const agent of ['build', 'plan', 'general', 'explore']) {
      expect(config.agent[agent].model).toBe(ref);
    }
  });

  it('контур модели не назвал — имя всё равно есть: без него Kimi ушёл бы к модели конфига', () => {
    connect({ ...PLATFORM, defaultModel: '' });
    const decision = resolveRunRoute(deps, 'foreign:kimi');
    expect(decision.routed && decision.env.KIMI_MODEL_NAME).toBe('default');
  });

  it('галочка снята — окружения нет', () => {
    connect({ ...PLATFORM, consumers: [] });
    expect(resolveRunRoute(deps, 'foreign:kimi')).toEqual({
      routed: false,
      reason: 'consumer_off',
    });
  });

  it('в списке «Где работает контур» все три доступны, а не «нет раздела переменных»', () => {
    const options = listConsumerOptions(PLATFORM);
    for (const id of ['foreign:kimi', 'foreign:goose', 'foreign:opencode']) {
      const option = options.find((item) => item.id === id);
      expect(option?.reason).toBeUndefined();
      expect(option?.selected).toBe(true);
    }
  });
});

describe('настройка конфига, уводящая часть прогона мимо контура', () => {
  it('Kimi с [secondary_model]: обязательный контур отказывает, назвав настройку', () => {
    writeConfig(
      join(kimiCodeHome(), 'config.toml'),
      'default_model = "k2"\n\n[secondary_model]\nmodel = "k2-mini"\n',
    );
    connect();
    const decision = resolveRunRoute(deps, 'foreign:kimi');
    expect(decision.routed).toBe(false);
    if (decision.routed) return;
    expect(decision.reason).toBe('cli_config_bypass');
    expect(decision.setting).toBe('[secondary_model] model');
    expect(decision.refusal).toContain('[secondary_model] model');
    const plan = describeRunPlan(deps, 'foreign:kimi');
    expect(plan).toMatchObject({ refused: true, setting: '[secondary_model] model' });
    expect(plan.bypassed).toBeUndefined();
  });

  it('Kimi без второй модели — маршрут есть', () => {
    writeConfig(join(kimiCodeHome(), 'config.toml'), 'default_model = "k2"\n');
    connect();
    expect(resolveRunRoute(deps, 'foreign:kimi').routed).toBe(true);
  });

  it('Goose с ведущей моделью другого провайдера: «по возможности» идёт мимо и говорит это', () => {
    writeConfig(
      join(gooseConfigDir(), 'config.yaml'),
      'GOOSE_PROVIDER: anthropic\nGOOSE_LEAD_PROVIDER: anthropic\nGOOSE_LEAD_MODEL: claude-x\n',
    );
    connect({ ...PLATFORM, mode: 'best-effort' });
    const decision = resolveRunRoute(deps, 'foreign:goose');
    expect(decision).toEqual({
      routed: false,
      reason: 'cli_config_bypass',
      setting: 'GOOSE_LEAD_PROVIDER',
    });
    expect(describeRunPlan(deps, 'foreign:goose')).toMatchObject({
      bypassed: true,
      setting: 'GOOSE_LEAD_PROVIDER',
    });
  });

  it('Goose с ведущим провайдером openai — тот же адрес, маршрут есть', () => {
    writeConfig(join(gooseConfigDir(), 'config.yaml'), 'GOOSE_LEAD_PROVIDER: openai\n');
    connect();
    expect(resolveRunRoute(deps, 'foreign:goose').routed).toBe(true);
  });
});

describe('Gemini: диалект google через шлюз (07.10.2026)', () => {
  const geminiSettings = (): string => join(root, 'home', '.gemini', 'settings.json');

  it('вход ключом API — адрес корня шлюза с меткой прогона, модель и заглушка ключа', () => {
    writeConfig(
      geminiSettings(),
      JSON.stringify({ security: { auth: { selectedType: 'gemini-api-key' } } }),
    );
    connect({ ...PLATFORM, consumers: ['foreign:gemini'] });
    const decision = resolveRunRoute(deps, 'foreign:gemini', '', 'run-2');
    expect(decision.routed).toBe(true);
    if (!decision.routed) return;
    expect(decision.env).toEqual({
      // Без /v1: gemini сам дописывает /v1beta/models/<модель>:<метод>.
      GOOGLE_GEMINI_BASE_URL: `${BASE}/gemini/_run/run-2`,
      GEMINI_MODEL: 'Qwen/Qwen3.8-27B',
      GEMINI_API_KEY: expect.not.stringContaining('CONTOUR-KEY'),
    });
  });

  it('старый ключ selectedAuthType тоже считается', () => {
    writeConfig(geminiSettings(), JSON.stringify({ selectedAuthType: 'gemini-api-key' }));
    connect({ ...PLATFORM, consumers: ['foreign:gemini'] });
    expect(resolveRunRoute(deps, 'foreign:gemini').routed).toBe(true);
  });

  it('вход Google-аккаунтом: обязательный контур отказывает, назвав настройку', () => {
    writeConfig(
      geminiSettings(),
      JSON.stringify({ security: { auth: { selectedType: 'oauth-personal' } } }),
    );
    connect({ ...PLATFORM, consumers: ['foreign:gemini'] });
    const decision = resolveRunRoute(deps, 'foreign:gemini');
    expect(decision).toMatchObject({
      routed: false,
      reason: 'cli_config_bypass',
      setting: 'security.auth.selectedType ≠ "gemini-api-key"',
    });
    expect(!decision.routed && decision.refusal).toContain('security.auth.selectedType');
  });

  it('способ входа не задан — тоже отказ: с адресом в окружении gemini не стартует', () => {
    connect({ ...PLATFORM, consumers: ['foreign:gemini'], mode: 'best-effort' });
    expect(resolveRunRoute(deps, 'foreign:gemini')).toEqual({
      routed: false,
      reason: 'cli_config_bypass',
      setting: 'security.auth.selectedType ≠ "gemini-api-key"',
    });
  });

  it('в списке «Где работает контур» gemini доступен, а не «диалект, которого шлюз не знает»', () => {
    const option = listConsumerOptions({ ...PLATFORM, consumers: ['foreign:gemini'] }).find(
      (item) => item.id === 'foreign:gemini',
    );
    expect(option?.reason).toBeUndefined();
  });
});

describe('модель — только окружением', () => {
  it('одиночный запуск Kimi, Goose и OpenCode не несёт имя модели флагом', async () => {
    const { getProvider } = await import('../../providers/registry.ts');
    for (const id of ['kimi', 'goose', 'opencode'] as const) {
      const args = getProvider(id).assistant?.oneShotArgs?.('вопрос', { model: 'contour-model-x' });
      // Имя флагом — псевдоним из конфига человека, а не модель контура.
      expect(args?.join(' ')).not.toContain('contour-model-x');
    }
  });
});

describe('Claude, уведённый settings.json мимо контура (07.10.2026)', () => {
  // `env` из settings.json перекрывает окружение прогона (замер на claude 2.1.286):
  // адрес контура в окружении тогда молча не действует.
  const SETTING = 'settings.json → env.ANTHROPIC_BASE_URL';
  const withRedirect = (platformId: string): PlatformRoutingDeps => ({
    ...deps,
    claudeSettingsRoute: () => ({ setting: SETTING, platformId }),
  });

  it('обязательный чужой контур — отказ с именем настройки', () => {
    connect({ ...PLATFORM, consumers: ['chat'] });
    const decision = resolveRunRoute(withRedirect('local-ollama'), 'chat');
    expect(decision).toMatchObject({
      routed: false,
      reason: 'cli_config_bypass',
      setting: SETTING,
    });
    expect(!decision.routed && decision.refusal).toContain(SETTING);
  });

  it('«по возможности» — мимо контура, без отказа', () => {
    connect({ ...PLATFORM, consumers: ['chat'], mode: 'best-effort' });
    expect(resolveRunRoute(withRedirect('local-ollama'), 'chat')).toEqual({
      routed: false,
      reason: 'cli_config_bypass',
      setting: SETTING,
    });
  });

  it('контур, ведущий туда же, куда настройка, — маршрут есть; чужому CLI настройка Claude не мешает', () => {
    connect({ ...PLATFORM, consumers: ['chat', 'foreign:kimi'] });
    expect(resolveRunRoute(withRedirect(PLATFORM.id), 'chat').routed).toBe(true);
    expect(resolveRunRoute(withRedirect('local-ollama'), 'foreign:kimi').routed).toBe(true);
  });

  it('без настройки — маршрут как был', () => {
    connect({ ...PLATFORM, consumers: ['chat'] });
    expect(resolveRunRoute(deps, 'chat').routed).toBe(true);
  });
});

describe('шапка чата при Claude, уведённом на локальную модель', () => {
  const LOCAL = { model: 'qwen3.6:27b-coding', title: 'Qwen3.6 27B Coding' };
  const withLocal = (platformId: string): PlatformRoutingDeps => ({
    ...deps,
    claudeSettingsRoute: () => ({
      setting: 'settings.json → env.ANTHROPIC_BASE_URL',
      platformId,
      ...LOCAL,
    }),
  });

  it('контура нет — план называет локальную модель для прогонов Claude, но не для чужого CLI', () => {
    const plan = describeRunPlan(withLocal('local-ollama'), 'chat');
    expect(plan).toMatchObject({ routed: false, reason: 'no_active_platform', local: LOCAL });
    expect(describeRunPlan(withLocal('local-ollama'), 'foreign:kimi').local).toBeUndefined();
    expect(describeRunPlan(deps, 'chat').local).toBeUndefined();
  });

  it('«по возможности» мимо чужого контура — тоже локальная; обязательный — отказ, не локальная', () => {
    connect({ ...PLATFORM, consumers: ['chat'], mode: 'best-effort' });
    expect(describeRunPlan(withLocal('local-ollama'), 'chat').local).toEqual(LOCAL);
    connect({ ...PLATFORM, consumers: ['chat'] });
    const refused = describeRunPlan(withLocal('local-ollama'), 'chat');
    expect(refused.refused).toBe(true);
    expect(refused.local).toBeUndefined();
  });

  it('контур, ведущий туда же, ведёт сам — локальной подписи нет', () => {
    connect({ ...PLATFORM, consumers: ['chat'] });
    const decision = resolveRunRoute(withLocal(PLATFORM.id), 'chat');
    expect(decision.routed).toBe(true);
    expect(localClaudeRun(withLocal(PLATFORM.id), 'chat', decision)).toBeUndefined();
  });
});
