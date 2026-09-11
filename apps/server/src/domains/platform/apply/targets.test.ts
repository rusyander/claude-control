import { describe, it, expect } from 'vitest';
import type { Platform } from '@agentdeck/contracts';
import { PLATFORM_ASSISTANT_TARGET } from '@agentdeck/contracts/platform';
import { listProviders } from '../../../providers/registry.ts';
import { buildManagedProfile, PLACEHOLDER_KEY } from './profile.ts';
import { contourEntryName, describeContourTargets, type ContourTarget } from './targets.ts';

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
  id: 'enterprise-platform-dev',
  title: 'EnterprisePlatform · dev',
  driver: 'enterprise-platform',
  baseUrl: 'https://api.dev.example.ru',
  enabled: true,
  mode: 'required',
  budgetUsd: 0,
  capabilities: [],
  targets: [],
  projectPaths: [],
  agents: [],
  budgetSince: '',
  caCertPath: '',
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
    expect(planValue(claude, 'ANTHROPIC_BASE_URL')).toBe('http://127.0.0.1:5179/enterprise-platform-dev');
    expect(planValue(claude, 'ANTHROPIC_MODEL')).toBe('gpt-4o');
    expect(planValue(claude, 'ANTHROPIC_AUTH_TOKEN')).toBe(PLACEHOLDER_KEY);
    expect(claude.plan.find((item) => item.key === 'ANTHROPIC_AUTH_TOKEN')?.placeholder).toBe(true);
  });

  it('qwen понимает оба диалекта — берётся родной для контура', () => {
    const qwen = byId('qwen');
    expect(planValue(qwen, 'OPENAI_BASE_URL')).toBe('http://127.0.0.1:5179/enterprise-platform-dev/v1');
    // Перевод в конвейере шлюза не понадобится вовсе: контур говорит на этом же.
    expect(planValue(qwen, 'ANTHROPIC_BASE_URL')).toBeUndefined();
  });

  it('aider: свои имена с префиксом, файл его собственный', () => {
    const aider = byId('aider');
    expect(planValue(aider, 'AIDER_OPENAI_API_BASE')).toBe('http://127.0.0.1:5179/enterprise-platform-dev/v1');
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
  it('codex: своя таблица в model_providers и корневой выбор провайдера', () => {
    const codex = byId('codex');
    const name = contourEntryName(PLATFORM.id);
    expect(codex.filePath).toContain('config.toml');
    expect(planValue(codex, `model_providers.${name}.base_url`)).toBe(
      'http://127.0.0.1:5179/enterprise-platform-dev/v1',
    );
    expect(planValue(codex, `model_providers.${name}.wire_api`)).toBe('chat');
    // Провайдер, которого никто не выбрал, — мёртвая запись.
    expect(planValue(codex, 'model_provider')).toBe(name);
    // Ключ у codex задаётся ИМЕНЕМ переменной, значение подставляет шлюз.
    expect(planValue(codex, `model_providers.${name}.env_key`)).toBe('CONTOUR_API_KEY');
    expect(JSON.stringify(codex.plan)).not.toContain(PLACEHOLDER_KEY);
  });

  it('continue: своя запись в списке моделей, чужие не упомянуты', () => {
    const cont = byId('continue');
    const name = contourEntryName(PLATFORM.id);
    expect(cont.filePath).toContain('config.yaml');
    expect(planValue(cont, `models[${name}].apiBase`)).toBe('http://127.0.0.1:5179/enterprise-platform-dev/v1');
    expect(planValue(cont, `models[${name}].provider`)).toBe('openai');
    expect(planValue(cont, `models[${name}].model`)).toBe('gpt-4o');
    expect(planValue(cont, `models[${name}].apiKey`)).toBe(PLACEHOLDER_KEY);
  });
});

describe('прочерки', () => {
  it('gemini — не «писать некуда», а диалект, которого шлюз не знает', () => {
    // Переменная адреса у gemini есть и задокументирована; беда не в ней, и
    // записать туда адрес значило бы получить 404 на первом же запросе.
    expect(byId('gemini').reason).toBe('gateway_dialect');
  });

  it.each(['goose', 'kimi', 'cursor', 'opencode'])('%s — писать некуда, и это сказано', (id) => {
    expect(byId(id).reason).toBe('no_env_section');
  });
});
