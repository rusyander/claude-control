import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bypassLabel, endpointApiKindOf, wireApiOf } from '@agentdeck/providers/channels';
import { CLI_RUN_FACTS } from '@agentdeck/providers/registry';
import type { CliRunFacts } from '@agentdeck/providers/types';
import { listProviders } from '../registry.ts';
import { endpointConfigOf, endpointFileOf, runEndpointOf, runFactsOf } from './run-facts.ts';

/**
 * Каталог панели против пакета фактов запуска: каждое поле, которое каталог берёт из
 * пакета, равно факту, а поля без факта в каталоге отсутствуют. Сверка в обе стороны —
 * и по списку CLI, и по наличию полей.
 */
describe('каталог панели = факты запуска', () => {
  it('один и тот же список CLI в одном порядке', () => {
    expect(listProviders().map((p) => p.id)).toEqual(CLI_RUN_FACTS.map((f) => f.id));
  });

  describe.each(CLI_RUN_FACTS.map((f) => [f.id, f] as const))('%s', (id, facts) => {
    const provider = listProviders().find((p) => p.id === id);
    if (!provider) throw new Error(`catalog lacks ${id}`);

    it('имя, статус, бинарь, API вендора', () => {
      expect(provider.name).toBe(facts.name);
      expect(provider.status).toBe(facts.status);
      expect(provider.cli).toEqual(facts.binary);
      expect(provider.assistant?.apiKind).toBe(facts.vendorApi.kind);
      expect(provider.assistant?.apiKeyEnvVars).toEqual(facts.vendorApi.keyVars);
      expect(provider.assistant?.apiBaseUrl).toBe(facts.vendorApi.baseUrl);
      expect('apiBaseUrl' in (provider.assistant ?? {})).toBe(
        facts.vendorApi.baseUrl !== undefined,
      );
      expect(provider.assistant?.cliRunnable).toBe(facts.cliRunnable);
    });

    it('каналы адреса: тройки переменных, файл, окружение прогона', () => {
      const vars = facts.channels.filter((c) => c.via === 'env' && c.form === 'vars');
      const expectedConfig = Object.fromEntries(
        vars.map((c) => [
          endpointApiKindOf(c.dialect),
          {
            baseUrlEnv: c.baseUrlVar,
            modelEnv: c.modelVar,
            modelPrefix: c.modelPrefix,
            credentialEnv: c.keyVar,
            bypass: c.bypass !== undefined,
          },
        ]),
      );
      const actualConfig = Object.fromEntries(
        Object.entries(provider.endpointConfig ?? {}).map(([kind, v]) => [
          kind,
          {
            baseUrlEnv: v?.baseUrlEnv,
            modelEnv: v?.modelEnv,
            modelPrefix: v?.modelPrefix,
            credentialEnv: v?.credentialEnv,
            bypass: v?.bypass !== undefined,
          },
        ]),
      );
      expect(actualConfig).toEqual(expectedConfig);
      expect('endpointConfig' in provider).toBe(vars.length > 0);

      const file = facts.channels.find((c) => c.via === 'file');
      expect(
        provider.endpointFile && {
          format: provider.endpointFile.format,
          apiKind: provider.endpointFile.apiKind,
          wireApi: provider.endpointFile.wireApi,
        },
      ).toEqual(
        file && {
          format: file.format,
          apiKind: endpointApiKindOf(file.dialect),
          wireApi: wireApiOf(file.dialect),
        },
      );

      const run = facts.channels.find((c) => c.via === 'env' && c.form === 'run');
      expect(provider.runEndpoint?.env).toBe(
        run?.via === 'env' && run.form === 'run' ? run.build : undefined,
      );
      expect(provider.runEndpoint?.bypass !== undefined).toBe(run?.bypass !== undefined);
    });

    it('вендоры и лестница моделей', () => {
      expect(provider.modelVendors).toEqual(facts.modelVendors);
      expect(provider.modelLadder).toEqual(facts.modelLadder);
      expect('modelVendors' in provider).toBe(facts.modelVendors !== undefined);
      expect('modelLadder' in provider).toBe(facts.modelLadder !== undefined);
    });
  });
});

describe('обход канала читает конфиг человека, подпись — из фактов', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'run-facts-home-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('APPDATA', join(home, 'AppData'));
    vi.stubEnv('XDG_CONFIG_HOME', join(home, '.config'));
    vi.stubEnv('KIMI_CODE_HOME', join(home, 'kimi'));
    vi.stubEnv('GEMINI_CLI_SYSTEM_SETTINGS_PATH', join(home, 'no-system.json'));
    vi.stubEnv('GEMINI_CLI_SYSTEM_DEFAULTS_PATH', join(home, 'no-defaults.json'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  const provider = (id: string) => {
    const found = listProviders().find((p) => p.id === id);
    if (!found) throw new Error(`catalog lacks ${id}`);
    return found;
  };

  it('Gemini: вход не ключом API — отказ с именем настройки и нужным значением', () => {
    const bypass = provider('gemini').endpointConfig?.google?.bypass;
    expect(bypass?.()).toBe('security.auth.selectedType ≠ "gemini-api-key"');
    mkdirSync(join(home, '.gemini'), { recursive: true });
    writeFileSync(
      join(home, '.gemini', 'settings.json'),
      JSON.stringify({ security: { auth: { selectedType: 'gemini-api-key' } } }),
    );
    expect(bypass?.()).toBeUndefined();
  });

  it('Kimi: вторая модель в конфиге — отказ «[secondary_model] model»', () => {
    const bypass = provider('kimi').runEndpoint?.bypass;
    expect(bypass?.()).toBeUndefined();
    mkdirSync(join(home, 'kimi'), { recursive: true });
    writeFileSync(join(home, 'kimi', 'config.toml'), '[secondary_model]\nmodel = "k2"\n');
    expect(bypass?.()).toBe('[secondary_model] model');
  });
});

describe('мост к каталогу отказывает, когда факты и каталог расходятся', () => {
  const bare: CliRunFacts = {
    id: 'bare',
    name: 'Bare',
    status: 'experimental',
    binary: { command: 'bare', windowsCommand: 'bare.cmd' },
    login: 'unknown',
    vendorApi: { kind: 'none', keyVars: [] },
    cliRunnable: false,
    channels: [],
  };

  it('нет фактов, нет канала — ошибка сборки, а не пустое поле', () => {
    expect(() => runFactsOf('no-such-cli')).toThrow('no run facts');
    expect(() => endpointConfigOf(bare)).toThrow('no env vars channel');
    expect(() => endpointFileOf(bare, () => 'x')).toThrow('no file channel');
    expect(() => runEndpointOf(bare)).toThrow('no run env channel');
  });

  it('обход заявлен, а проверки нет (и наоборот) — ошибка', () => {
    expect(() => endpointConfigOf(runFactsOf('gemini'))).toThrow('do not match');
    expect(() => runEndpointOf(runFactsOf('opencode'), () => true)).toThrow('do not match');
  });

  it('окружение прогона не в диалекте OpenAI — ошибка, панель его не умеет', () => {
    const anthropicRun: CliRunFacts = {
      ...bare,
      channels: [{ via: 'env', form: 'run', dialect: 'anthropic-messages', build: () => ({}) }],
    };
    expect(() => runEndpointOf(anthropicRun)).toThrow('not OpenAI-compatible');
  });

  it('подпись обхода берётся у фактов: проверка «мешает» даёт имя настройки', () => {
    const goose = runFactsOf('goose');
    const run = runEndpointOf(goose, () => true);
    const channel = goose.channels.find((c) => c.via === 'env' && c.form === 'run');
    expect(channel?.via === 'env' && channel.bypass ? bypassLabel(channel.bypass) : null).toBe(
      'GOOSE_LEAD_PROVIDER',
    );
    expect(run.bypass?.()).toBe('GOOSE_LEAD_PROVIDER');
    expect(runEndpointOf(goose, () => false).bypass?.()).toBeUndefined();
  });
});
