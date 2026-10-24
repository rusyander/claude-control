import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { defaultOurRules, defaultPlatformRules } from '@agentdeck/contracts/platform';
import { defaultPlatformTransport } from '@agentdeck/contracts/platform-transport';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Platform } from '@agentdeck/contracts';
import { AppStore } from '../../lib/app-store/app-store.ts';
import { writePlatform, writeToken } from '../../domains/platform/store/store.ts';
import { applyContour } from '../../domains/platform/apply/apply.ts';
import { rollbackContour } from '../../domains/platform/apply/rollback.ts';
import type { PlatformRoutingDeps } from '../../domains/platform/routing/routing.ts';
import { foreignDeliverContourRoute } from './runtime.ts';

/**
 * Проводка `contourRoute` планировщика стадий чужих CLI: без неё дешёвая доставка
 * выключена (закрыто по умолчанию), а с ней решение берётся НАСТОЯЩИМ
 * `resolveRunRoute` для потребителя `foreign:<cli>` — тем же, что у прогона.
 * Хранилище и контур — настоящие файлы во временном каталоге.
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
  consumers: ['foreign:qwen'],
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

let root: string;
let dir: string;
let store: AppStore;
let deps: PlatformRoutingDeps;
/** `config.toml` Codex во временном доме (`CODEX_HOME`): настоящий дом не читается. */
let codexToml: string;

function connect(platform: Platform): void {
  writePlatform(store, platform);
  writeToken(dir, platform.id, 'CONTOUR-KEY-TEST');
  store.updateSettings({ activePlatformId: platform.id });
}

/** След применения контура к файлу CLI — то, что пишет `apply.ts`. */
function applyTo(targetId: string, platformId = PLATFORM.id): void {
  store.savePlatformApplied(platformId, {
    platformId,
    profileId: `${platformId}-managed`,
    targets: [
      {
        targetId,
        filePath: join(root, `${targetId}.toml`),
        appliedAt: '2026-10-23T00:00:00.000Z',
        previous: [],
        fingerprint: 'sha1',
      },
    ],
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-rt-contour-route-'));
  dir = join(root, 'agentdeck');
  mkdirSync(dir, { recursive: true });
  store = new AppStore(dir);
  deps = { store, appDataDir: dir, gatewayPort: () => 5179 };
  mkdirSync(join(root, 'codex'), { recursive: true });
  codexToml = join(root, 'codex', 'config.toml');
  vi.stubEnv('CODEX_HOME', join(root, 'codex'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('foreignDeliverContourRoute: маршрут дешёвой доставки чужой группы', () => {
  it('контура нет — не через контур', () => {
    expect(foreignDeliverContourRoute(deps, 'qwen')).toEqual({ routed: false });
  });

  it('контур ведёт этот CLI — через контур, с ключами карты моделей строчными', () => {
    connect({ ...PLATFORM, modelMap: { ' Qwen3-Coder-Flash ': 'company-small' } });
    expect(foreignDeliverContourRoute(deps, 'qwen')).toEqual({
      routed: true,
      modelMapKeys: ['qwen3-coder-flash'],
    });
  });

  it('карта пуста — через контур без ключей: младшей ступени там нет', () => {
    connect(PLATFORM);
    expect(foreignDeliverContourRoute(deps, 'qwen')).toEqual({ routed: true });
  });

  it('CLI не в списке контура — не через контур', () => {
    connect({ ...PLATFORM, consumers: ['chat'] });
    expect(foreignDeliverContourRoute(deps, 'qwen')).toEqual({ routed: false });
  });

  // Codex контур ведёт только файлом конфига (`file_only`): галочка чата его прогон
  // не уводит. Пока файл не тронут, прогон идёт мимо контура.
  it('Codex в списке контура, файл не применён — не через контур (file_only)', () => {
    connect({ ...PLATFORM, consumers: ['foreign:codex'] });
    expect(foreignDeliverContourRoute(deps, 'codex')).toEqual({ routed: false });
  });

  // Применённый к config.toml контур уводит в шлюз КАЖДЫЙ прогон Codex, группы
  // тоже: окружение тут ни при чём. Ответ «мимо контура» открыл бы младшей
  // ступени каталога дорогу в контур без строки карты.
  it('контур применён к файлу Codex — через контур, с ключами карты этого контура', () => {
    connect({
      ...PLATFORM,
      consumers: ['foreign:codex'],
      modelMap: { ' GPT-5.4-Mini ': 'company-small', 'o-skip': ' ' },
    });
    applyTo('codex');
    expect(foreignDeliverContourRoute(deps, 'codex')).toEqual({
      routed: true,
      modelMapKeys: ['gpt-5.4-mini'],
    });
  });

  it('контур применён к файлу Codex, карта пуста — через контур без ключей', () => {
    connect({ ...PLATFORM, consumers: [] });
    applyTo('codex');
    expect(foreignDeliverContourRoute(deps, 'codex')).toEqual({ routed: true });
  });

  // След применения пережил сам контур (удалён из настроек, файл не откатан):
  // карта неизвестна — через контур без ключей, то есть дешёвая доставка закрыта.
  it('след применения без контура в настройках — через контур без ключей', () => {
    applyTo('codex', 'gone');
    expect(foreignDeliverContourRoute(deps, 'codex')).toEqual({ routed: true });
  });

  it('контур применён к файлу другого CLI — Codex не через контур', () => {
    connect({ ...PLATFORM, consumers: [], modelMap: { a: 'b' } });
    applyTo('qwen');
    expect(foreignDeliverContourRoute(deps, 'codex')).toEqual({ routed: false });
  });
});

/**
 * След применения врёт о файле Codex в обе стороны (ревью 🟡3): откат оставляет
 * правленный рукой файл как есть (`kept`) и всё равно вычёркивает цель, а запись
 * шлюза, вписанную человеком, след не знает вовсе. Тогда решает сам `config.toml`
 * — настоящий файл, который читает провайдер (`CODEX_HOME` во временном каталоге).
 */
describe('foreignDeliverContourRoute: собственный файл Codex, а не только след', () => {
  const CODEX_CONTOUR: Platform = { ...PLATFORM, consumers: ['terminal'] };
  const SPARK_MAP = { 'GPT-5.3-Codex-Spark': 'company-small' };

  it('откат оставил правленный файл (kept) и вычеркнул цель — через контур, с ключами карты', () => {
    const platform: Platform = { ...CODEX_CONTOUR, modelMap: SPARK_MAP };
    connect(platform);
    store.updateSettings({ platformGateway: { enabled: true, port: 5179, forceStream: true } });
    writeFileSync(codexToml, 'model = "gpt-5.4"\n');
    const applyDeps = {
      store,
      paths: { claudeSettings: join(root, 'claude-settings.json') },
      backupDir: join(root, 'backups'),
      gatewayRunning: true,
    };
    const applied = applyContour(applyDeps, platform, { targets: ['codex'], model: 'gpt-5.4' });
    expect(applied.applied.map((item) => item.targetId)).toEqual(['codex']);

    // Человек правит НАШУ таблицу: отпечаток расходится, откат файл не трогает.
    const text = readFileSync(codexToml, 'utf8');
    writeFileSync(codexToml, text.replace('CONTOUR_API_KEY', 'MY_OWN_KEY'));
    const rolled = rollbackContour(applyDeps, platform.id, { targetIds: ['codex'] });
    expect(rolled.entries.map((item) => item.outcome)).toEqual(['kept']);
    const record = store.getPlatformApplied()[platform.id];
    expect(record?.targets.some((item) => item.targetId === 'codex') ?? false).toBe(false);
    expect(readFileSync(codexToml, 'utf8')).toContain('model_provider = "contour-company-dev"');

    expect(foreignDeliverContourRoute(deps, 'codex')).toEqual({
      routed: true,
      modelMapKeys: ['gpt-5.3-codex-spark'],
    });
  });

  it('запись контура вписана рукой, следа нет — через контур, с ключами его карты', () => {
    connect({ ...CODEX_CONTOUR, modelMap: SPARK_MAP });
    writeFileSync(
      codexToml,
      [
        'model_provider = "contour-company-dev"',
        '',
        '[model_providers.contour-company-dev]',
        'base_url = "https://anywhere.example/v1"',
        '',
      ].join('\n'),
    );
    expect(foreignDeliverContourRoute(deps, 'codex')).toEqual({
      routed: true,
      modelMapKeys: ['gpt-5.3-codex-spark'],
    });
  });

  it('свой провайдер с адресом шлюза панели — через контур, с ключами названного контура', () => {
    connect({ ...CODEX_CONTOUR, modelMap: SPARK_MAP });
    writeFileSync(
      codexToml,
      [
        'model_provider = "mine"',
        '',
        '[model_providers.mine]',
        'base_url = "http://127.0.0.1:5179/company-dev/_s/terminal/v1"',
        '',
      ].join('\n'),
    );
    expect(foreignDeliverContourRoute(deps, 'codex')).toEqual({
      routed: true,
      modelMapKeys: ['gpt-5.3-codex-spark'],
    });
  });

  it('адрес на порт шлюза, контур в адресе неизвестен — через контур без ключей', () => {
    writeFileSync(
      codexToml,
      'model_provider = "mine"\n\n[model_providers.mine]\nbase_url = "http://localhost:5179/v1"\n',
    );
    expect(foreignDeliverContourRoute(deps, 'codex')).toEqual({ routed: true });
  });

  it('выбор в профиле Codex тоже считается: профиль уводит в шлюз — через контур', () => {
    writeFileSync(
      codexToml,
      'profile = "work"\n\n[profiles.work]\nmodel_provider = "contour-gone"\n',
    );
    expect(foreignDeliverContourRoute(deps, 'codex')).toEqual({ routed: true });
  });

  it('файл не разбирается — через контур без ключей (закрыто)', () => {
    connect({ ...CODEX_CONTOUR, modelMap: SPARK_MAP });
    writeFileSync(codexToml, 'model_provider = "contour-company-dev\n[[[broken');
    expect(foreignDeliverContourRoute(deps, 'codex')).toEqual({ routed: true });
  });

  it('облачный провайдер и локальный сервер не на порту шлюза — не через контур', () => {
    connect({ ...CODEX_CONTOUR, modelMap: SPARK_MAP });
    // Неактивная запись контура в файле ничего не уводит: выбран облачный openai.
    writeFileSync(
      codexToml,
      [
        'model_provider = "openai"',
        '',
        '[model_providers.ollama-own]',
        'base_url = "http://127.0.0.1:11434/v1"',
        '',
        '[model_providers.contour-company-dev]',
        'base_url = "http://127.0.0.1:5179/company-dev/v1"',
        '',
      ].join('\n'),
    );
    expect(foreignDeliverContourRoute(deps, 'codex')).toEqual({ routed: false });
    writeFileSync(
      codexToml,
      'model_provider = "ollama-own"\n\n[model_providers.ollama-own]\nbase_url = "http://127.0.0.1:11434/v1"\n',
    );
    expect(foreignDeliverContourRoute(deps, 'codex')).toEqual({ routed: false });
  });

  it('файла нет — не через контур', () => {
    connect({ ...CODEX_CONTOUR, modelMap: SPARK_MAP });
    expect(foreignDeliverContourRoute(deps, 'codex')).toEqual({ routed: false });
  });
});
