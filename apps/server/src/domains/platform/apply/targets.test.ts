import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultOurRules, defaultPlatformRules } from '@agentdeck/contracts/platform';
import type { Platform } from '@agentdeck/contracts';
import { PLATFORM_ASSISTANT_TARGET } from '@agentdeck/contracts/platform';
import { listProviders } from '../../../providers/registry.ts';
import { buildManagedProfile, PLACEHOLDER_KEY } from './profile.ts';
import {
  contourEntryName,
  describeContourTargets,
  filePlanFor,
  type ContourTarget,
} from './targets.ts';
import { defaultPlatformTransport } from '@agentdeck/contracts/platform-transport';

/**
 * Куда контур переносится и почему у части CLI стоит прочерк.
 *
 * Это тот самый список «Применён к», и главное свойство здесь — у КАЖДОГО
 * прочерка названа причина. Молча пропавшая строка означала бы для человека
 * «панель не умеет», хотя причины разные и решаются по-разному: одному CLI
 * писать некуда вовсе, у другого нет задокументированной переменной, у третьего
 * диалект, которого шлюз не понимает.
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
  projectPaths: [],
  consumers: [],
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

const GATEWAY = { enabled: true, port: 5179, forceStream: true };
const PATHS = { claudeSettings: 'C:/tmp/claude/settings.json' };

function targetsOf(model = 'gpt-4o'): ContourTarget[] {
  const managed = buildManagedProfile(PLATFORM, GATEWAY, model);
  return describeContourTargets(managed, PLATFORM.id, GATEWAY.port, PATHS);
}

const byId = (id: string): ContourTarget => {
  const target = targetsOf().find((item) => item.targetId === id);
  if (!target) throw new Error(`нет цели ${id}`);
  return target;
};

const planValue = (target: ContourTarget, key: string): string | undefined =>
  target.plan.find((item) => item.key === key)?.value;

describe('список целей', () => {
  it('ассистент панели идёт первым и не трогает ни одного файла', () => {
    const first = targetsOf()[0];
    expect(first?.targetId).toBe(PLATFORM_ASSISTANT_TARGET);
    // Единственный сценарий, который через контур работает полностью: у CLI
    // своих инструментов там нет. Предлагать его последним было бы враньём о
    // ценности.
    expect(first?.filePath).toBe('');
    expect(first?.plan).toEqual([]);
    expect(first?.write).toEqual({ kind: 'assistant' });
  });

  it('в списке ровно все известные CLI и ассистент — никто не пропал', () => {
    const ids = targetsOf().map((item) => item.targetId);
    expect(ids).toEqual([PLATFORM_ASSISTANT_TARGET, ...listProviders().map((item) => item.id)]);
  });

  it('у каждой цели либо запись, либо названная причина прочерка', () => {
    for (const target of targetsOf()) {
      if (target.write) {
        expect(target.reason).toBeUndefined();
        continue;
      }
      // Прочерк без причины человек читает как «панель не умеет» и идёт
      // настраивать руками — то есть мимо контура.
      expect(target.reason).toBeDefined();
      expect(target.plan).toEqual([]);
      expect(target.filePath).toBe('');
    }
  });
});

describe('цели с переменными окружения', () => {
  it('claude: адрес, модель и ЗАГЛУШКА вместо ключа в его же файл настроек', () => {
    const claude = byId('claude');
    expect(claude.filePath).toBe(PATHS.claudeSettings);
    // Диалект anthropic: адрес идёт КОРНЕМ, версию CLI дописывает сам.
    expect(planValue(claude, 'ANTHROPIC_BASE_URL')).toBe(
      'http://127.0.0.1:5179/company-dev/_s/terminal',
    );
    expect(planValue(claude, 'ANTHROPIC_MODEL')).toBe('gpt-4o');
    expect(planValue(claude, 'ANTHROPIC_AUTH_TOKEN')).toBe(PLACEHOLDER_KEY);
    expect(claude.plan.find((item) => item.key === 'ANTHROPIC_AUTH_TOKEN')?.placeholder).toBe(true);
  });

  it('qwen понимает оба диалекта — берётся родной для контура', () => {
    const qwen = byId('qwen');
    expect(planValue(qwen, 'OPENAI_BASE_URL')).toBe(
      'http://127.0.0.1:5179/company-dev/_s/terminal/v1',
    );
    // Перевод в конвейере шлюза не понадобится вовсе: контур говорит на этом же.
    expect(planValue(qwen, 'ANTHROPIC_BASE_URL')).toBeUndefined();
  });

  it('aider: свои имена с префиксом, файл его собственный', () => {
    const aider = byId('aider');
    expect(planValue(aider, 'AIDER_OPENAI_API_BASE')).toBe(
      'http://127.0.0.1:5179/company-dev/_s/terminal/v1',
    );
    expect(aider.filePath).toContain('.aider.conf.yml');
  });

  it('пустая модель не выдумывает переменную модели', () => {
    const managed = buildManagedProfile(PLATFORM, GATEWAY, '');
    const claude = describeContourTargets(managed, PLATFORM.id, GATEWAY.port, PATHS).find(
      (item) => item.targetId === 'claude',
    );
    // CLI пойдёт со своей моделью по умолчанию — это его собственное поведение,
    // и подменять его пустой строкой панель не станет.
    expect(claude?.plan.map((item) => item.key)).toEqual([
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_AUTH_TOKEN',
    ]);
  });
});

describe('цели с куском конфигурации', () => {
  it('codex: цель предлагается — шлюз обслуживает его ручку /v1/responses (MAP D)', () => {
    // До MAP D здесь стоял прочерк `gateway_dialect`: конфиг с `wire_api = "chat"`
    // codex не загружает целиком (живая проба 22.09.2026), а `/responses` шлюз
    // не обслуживал. Маршрут появился — цель поднялась из прочерков сама, по
    // списку маршрутов шлюза, без второго перечня.
    const codex = byId('codex');
    expect(codex.reason).toBeUndefined();
    expect(codex.write?.kind).toBe('endpoint-file');
    expect(codex.filePath.endsWith('config.toml')).toBe(true);
    expect(codex.plan.map((item) => item.key)).toContain('model_provider');
  });

  it('план codex, когда ручка появится, несёт ручку САМОГО CLI, а не удобную шлюзу', () => {
    // Вторая половина того же решения: построитель плана не «разучился» писать
    // codex — он не зовётся, пока цель прочерк. Значение `wire_api` при этом
    // берётся из каталога: зашитое `chat` и было тем, что ломало CLI.
    const file = listProviders().find((item) => item.id === 'codex')?.endpointFile;
    if (!file) throw new Error('у codex нет endpointFile');
    const name = contourEntryName(PLATFORM.id);
    const plan = filePlanFor(file, PLATFORM.id, 5179, 'gpt-4o');
    const valueOf = (key: string) => plan.find((item) => item.key === key)?.value;

    expect(valueOf(`model_providers.${name}.base_url`)).toBe(
      'http://127.0.0.1:5179/company-dev/_s/terminal/v1',
    );
    expect(valueOf(`model_providers.${name}.wire_api`)).toBe('responses');
    expect(valueOf(`model_providers.${name}.env_key`)).toBe('CONTOUR_API_KEY');
    // Провайдер, которого никто не выбрал, — мёртвая запись.
    expect(valueOf('model_provider')).toBe(name);
    expect(JSON.stringify(plan)).not.toContain(PLACEHOLDER_KEY);
  });

  it('continue: своя запись в списке моделей, чужие не упомянуты', () => {
    const cont = byId('continue');
    const name = contourEntryName(PLATFORM.id);
    expect(cont.filePath).toContain('config.yaml');
    expect(planValue(cont, `models[${name}].apiBase`)).toBe(
      'http://127.0.0.1:5179/company-dev/_s/terminal/v1',
    );
    expect(planValue(cont, `models[${name}].provider`)).toBe('openai');
    expect(planValue(cont, `models[${name}].model`)).toBe('gpt-4o');
    expect(planValue(cont, `models[${name}].apiKey`)).toBe(PLACEHOLDER_KEY);
  });
});

describe('прочерки', () => {
  describe('gemini: адрес пишется, только если CLI его прочтёт', () => {
    let home = '';
    /** Временный дом с настройками Gemini; системные — тоже во временном. */
    const geminiHome = (settings?: unknown): void => {
      home = mkdtempSync(join(tmpdir(), 'cc-targets-gemini-'));
      vi.stubEnv('USERPROFILE', home);
      vi.stubEnv('HOME', home);
      vi.stubEnv('GEMINI_CLI_SYSTEM_SETTINGS_PATH', join(home, 'system', 'settings.json'));
      vi.stubEnv('GEMINI_CLI_SYSTEM_DEFAULTS_PATH', join(home, 'system', 'defaults.json'));
      if (settings === undefined) return;
      mkdirSync(join(home, '.gemini'), { recursive: true });
      writeFileSync(join(home, '.gemini', 'settings.json'), JSON.stringify(settings));
    };
    afterEach(() => {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    });

    it('вход ключом API — цель в .env: корень шлюза без /v1, CLI сам допишет /v1beta', () => {
      geminiHome({ security: { auth: { selectedType: 'gemini-api-key' } } });
      const target = byId('gemini');
      expect(target.reason).toBeUndefined();
      expect(planValue(target, 'GOOGLE_GEMINI_BASE_URL')).toBe(
        'http://127.0.0.1:5179/company-dev/_s/terminal',
      );
      expect(planValue(target, 'GEMINI_API_KEY')).toBe(PLACEHOLDER_KEY);
    });

    it.each([
      ['способ входа не задан — с переменной адреса gemini не стартует', {}],
      [
        'вход Google-аккаунтом идёт своим сервером',
        { security: { auth: { selectedType: 'oauth-personal' } } },
      ],
    ])('%s → прочерк cli_config_bypass', (_name, settings) => {
      geminiHome(settings);
      expect(byId('gemini').reason).toBe('cli_config_bypass');
    });

    it('системные настройки сильнее пользовательских', () => {
      geminiHome({ security: { auth: { selectedType: 'gemini-api-key' } } });
      mkdirSync(join(home, 'system'), { recursive: true });
      writeFileSync(
        join(home, 'system', 'settings.json'),
        JSON.stringify({ security: { auth: { selectedType: 'vertex-ai' } } }),
      );
      expect(byId('gemini').reason).toBe('cli_config_bypass');
    });
  });

  it.each(['goose', 'kimi', 'cursor', 'opencode'])('%s — писать некуда, и это сказано', (id) => {
    expect(byId(id).reason).toBe('no_env_section');
  });
});
