import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isLoopbackUrl, ownLocalEndpoint, type OwnEndpointInput } from './own-endpoint.ts';

/**
 * @covers own-endpoint.ts — `ownLocalEndpoint`
 * @scenario Qwen Code или Codex, направленный СВОИМИ настройками на петлевой сервер
 *   моделей, — локальный ход; облачный адрес, запись контура, адрес шлюза панели,
 *   неразборчивый файл и отсутствие адреса — не локальный (облако, как до ответа).
 *   Каталоги CLI — временные (`QWEN_HOME`, `CODEX_HOME`, домашний), настройки этой
 *   машины не читаются.
 */

const SETTINGS = 'QWEN_CODE_SYSTEM_SETTINGS_PATH';
const GATEWAY_PORT = 5190;

describe('ownLocalEndpoint', () => {
  let root: string;
  let qwenHome: string;
  let codexHome: string;
  let workdir: string;
  let env: Record<string, string>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-own-endpoint-'));
    qwenHome = join(root, 'qwen-home');
    codexHome = join(root, 'codex-home');
    workdir = join(root, 'project');
    for (const dir of [qwenHome, codexHome, workdir]) mkdirSync(dir, { recursive: true });
    // Системный файл Qwen подменён отсутствующим: машинных настроек проверка не видит.
    env = { QWEN_HOME: qwenHome, CODEX_HOME: codexHome, [SETTINGS]: join(root, 'machine.json') };
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const ask = (providerId: string, patch: Partial<OwnEndpointInput> = {}): boolean =>
    ownLocalEndpoint({
      providerId,
      env,
      workdir,
      platformIds: ['corp'],
      gatewayPort: GATEWAY_PORT,
      home: root,
      ...patch,
    });
  const qwenSettings = (value: unknown, dir = qwenHome): void =>
    writeFileSync(join(dir, 'settings.json'), JSON.stringify(value));
  const codexConfig = (text: string): void => writeFileSync(join(codexHome, 'config.toml'), text);
  const openaiAuth = { security: { auth: { selectedType: 'openai' } } };

  describe('Qwen Code', () => {
    it('OPENAI_BASE_URL on 127.0.0.1 (Ollama) — local', () => {
      qwenSettings(openaiAuth);
      env.OPENAI_BASE_URL = 'http://127.0.0.1:11434/v1';
      expect(ask('qwen')).toBe(true);
    });

    it('auth chosen by env alone (key + model + address) — local', () => {
      Object.assign(env, {
        OPENAI_API_KEY: 'ollama',
        OPENAI_MODEL: 'qwen3-coder:30b',
        OPENAI_BASE_URL: 'http://localhost:11434/v1',
      });
      expect(ask('qwen')).toBe(true);
    });

    it('security.auth.baseUrl on localhost — local', () => {
      qwenSettings({
        security: { auth: { selectedType: 'openai', baseUrl: 'http://localhost:1234/v1' } },
      });
      expect(ask('qwen')).toBe(true);
    });

    it('cloud address (DashScope) — not local', () => {
      qwenSettings(openaiAuth);
      env.OPENAI_BASE_URL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
      expect(ask('qwen')).toBe(false);
    });

    it('modelProviders entry of the run model wins over the env address', () => {
      qwenSettings({
        ...openaiAuth,
        model: { name: 'qwen3-coder:30b', baseUrl: 'http://127.0.0.1:8000/v1' },
        modelProviders: {
          openai: [
            { id: 'qwen3-coder:30b', baseUrl: 'https://api.example.com/v1' },
            { id: 'qwen3-coder:30b', baseUrl: 'http://127.0.0.1:8000/v1' },
          ],
        },
      });
      env.OPENAI_BASE_URL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
      // Сохранённый `model.baseUrl` выбирает локальную запись — её адрес и действует.
      expect(ask('qwen')).toBe(true);
      // Модель хода флагом — сохранённый адрес не выбирает, берётся первая запись.
      expect(ask('qwen', { model: 'qwen3-coder:30b' })).toBe(false);
    });

    it('address from the project .qwen/.env when the run env has none — local', () => {
      qwenSettings(openaiAuth);
      mkdirSync(join(workdir, '.qwen'));
      writeFileSync(join(workdir, '.qwen', '.env'), 'OPENAI_BASE_URL=http://[::1]:11434/v1\n');
      expect(ask('qwen')).toBe(true);
    });

    it('panel gateway on loopback (its port or a contour first segment) — not local', () => {
      qwenSettings(openaiAuth);
      env.OPENAI_BASE_URL = `http://127.0.0.1:${GATEWAY_PORT}/corp/v1`;
      expect(ask('qwen')).toBe(false);
      env.OPENAI_BASE_URL = `http://127.0.0.1:${GATEWAY_PORT}/v1`;
      expect(ask('qwen')).toBe(false);
      // Порт шлюза сменился, а адрес записан со старым — контур узнаётся по пути.
      env.OPENAI_BASE_URL = 'http://127.0.0.1:4999/corp/v1';
      expect(ask('qwen')).toBe(false);
    });

    it('Qwen OAuth, unparseable settings, no address — not local', () => {
      qwenSettings({ security: { auth: { selectedType: 'qwen-oauth' } } });
      env.OPENAI_BASE_URL = 'http://127.0.0.1:11434/v1';
      expect(ask('qwen')).toBe(false);

      writeFileSync(join(qwenHome, 'settings.json'), '{ not json');
      expect(ask('qwen')).toBe(false);

      qwenSettings(openaiAuth);
      delete env.OPENAI_BASE_URL;
      expect(ask('qwen')).toBe(false);
    });

    it('a broken .env makes the address unknown — not local', () => {
      qwenSettings({
        security: { auth: { selectedType: 'openai', baseUrl: 'http://localhost:1234/v1' } },
      });
      writeFileSync(join(qwenHome, '.env'), 'this is not an assignment\n');
      expect(ask('qwen')).toBe(false);
    });
  });

  describe('Codex', () => {
    it('active model_provider with a localhost base_url — local', () => {
      codexConfig(
        [
          'model_provider = "vllm"',
          '[model_providers.vllm]',
          'name = "vLLM"',
          'base_url = "http://localhost:8000/v1"',
          '',
        ].join('\n'),
      );
      expect(ask('codex')).toBe(true);
    });

    it('built-in oss / ollama / lmstudio — local; CODEX_OSS_BASE_URL elsewhere — not', () => {
      for (const name of ['oss', 'ollama', 'lmstudio']) {
        codexConfig(`model_provider = "${name}"\n`);
        expect(ask('codex')).toBe(true);
      }
      env.CODEX_OSS_BASE_URL = 'http://gpu-box.example.com:11434/v1';
      expect(ask('codex')).toBe(false);
    });

    it('active profile picks the provider over the root one', () => {
      codexConfig(
        [
          'model_provider = "openai"',
          'profile = "home"',
          '[profiles.home]',
          'model_provider = "ollama"',
          '',
        ].join('\n'),
      );
      expect(ask('codex')).toBe(true);
    });

    it('panel contour entry contour-<id> or the gateway port — not local', () => {
      codexConfig(
        [
          'model_provider = "contour-corp"',
          '[model_providers.contour-corp]',
          `base_url = "http://127.0.0.1:${GATEWAY_PORT}/corp/v1"`,
          '',
        ].join('\n'),
      );
      expect(ask('codex')).toBe(false);
      codexConfig(
        [
          'model_provider = "mine"',
          '[model_providers.mine]',
          `base_url = "http://127.0.0.1:${GATEWAY_PORT}/v1"`,
          '',
        ].join('\n'),
      );
      expect(ask('codex')).toBe(false);
    });

    it('cloud provider, no config, unparseable config — not local', () => {
      expect(ask('codex')).toBe(false);
      codexConfig('model = "gpt-5"\n');
      expect(ask('codex')).toBe(false);
      codexConfig(
        'model_provider = "azure"\n[model_providers.azure]\nbase_url = "https://x.openai.azure.com/v1"\n',
      );
      expect(ask('codex')).toBe(false);
      codexConfig(
        'model_provider = "vllm"\n[model_providers.vllm\nbase_url = "http://localhost:1"',
      );
      expect(ask('codex')).toBe(false);
    });
  });

  it('other CLIs are not asked — not local', () => {
    env.OPENAI_BASE_URL = 'http://127.0.0.1:11434/v1';
    expect(ask('goose')).toBe(false);
  });

  it('loopback: localhost, 127.0.0.0/8, ::1, 0.0.0.0; not a LAN host or a lookalike', () => {
    for (const url of [
      'http://localhost:11434/v1',
      'http://127.0.0.1:1234',
      'http://127.8.9.10/v1',
      'http://[::1]:8000',
      'http://0.0.0.0:8000/v1',
    ]) {
      expect(isLoopbackUrl(url), url).toBe(true);
    }
    for (const url of [
      'http://192.168.1.5:11434/v1',
      'http://localhost.example.com/v1',
      'https://api.openai.com/v1',
      'not a url',
    ]) {
      expect(isLoopbackUrl(url), url).toBe(false);
    }
  });
});
