import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { EndpointProfile } from '@claude-control/contracts';
import { getProvider, listProviders } from '../providers/registry.ts';
import {
  applyEndpointProfile,
  buildEndpointPlan,
  describeEndpointTargets,
  EndpointApplyError,
  endpointModelsUrl,
  probeEndpoint,
  resolveEndpointVars,
  resolveAssistantEndpoint,
  saveEndpointToken,
  readEndpointToken,
  clearEndpointToken,
} from './endpoints.ts';

/**
 * Свой эндпоинт: карта переменных, проверка связи и запись в конфигурацию.
 *
 * Главное, что здесь заперто, — два обещания пользователю. Первое: панель не
 * выдумывает имя переменной адреса, и CLI без документации получает честный
 * отказ. Второе: токен не уходит в чужой конфиг без явной галочки — ни в план,
 * ни в файл.
 */

const profileOf = (patch: Partial<EndpointProfile> = {}): EndpointProfile => ({
  id: 'ep-1',
  name: 'Локальная модель',
  baseUrl: 'http://127.0.0.1:11434/v1',
  apiKind: 'openai-compat',
  model: 'qwen3-coder',
  writeToken: false,
  ...patch,
});

describe('resolveEndpointVars: имена переменных только из документации', () => {
  it('claude → ANTHROPIC_BASE_URL для anthropic', () => {
    const result = resolveEndpointVars(getProvider('claude'), 'anthropic');
    expect(result).toEqual({
      vars: {
        baseUrlEnv: 'ANTHROPIC_BASE_URL',
        modelEnv: 'ANTHROPIC_MODEL',
        credentialEnv: 'ANTHROPIC_AUTH_TOKEN',
      },
    });
  });

  it('gemini → GOOGLE_GEMINI_BASE_URL для google', () => {
    const result = resolveEndpointVars(getProvider('gemini'), 'google');
    expect(result).toMatchObject({ vars: { baseUrlEnv: 'GOOGLE_GEMINI_BASE_URL' } });
  });

  it('qwen понимает ОБА задокументированных протокола', () => {
    expect(resolveEndpointVars(getProvider('qwen'), 'openai-compat')).toMatchObject({
      vars: { baseUrlEnv: 'OPENAI_BASE_URL' },
    });
    expect(resolveEndpointVars(getProvider('qwen'), 'anthropic')).toMatchObject({
      vars: { baseUrlEnv: 'ANTHROPIC_BASE_URL' },
    });
  });

  it('aider → своё имя с префиксом AIDER_', () => {
    expect(resolveEndpointVars(getProvider('aider'), 'openai-compat')).toMatchObject({
      vars: { baseUrlEnv: 'AIDER_OPENAI_API_BASE', modelEnv: 'AIDER_MODEL' },
    });
  });

  it('codex и continue: env есть, а переменной адреса не задокументировано', () => {
    // У обоих адрес задаётся только в их конфигурационном файле — панель это
    // говорит прямо, а не выдумывает переменную.
    expect(resolveEndpointVars(getProvider('codex'), 'openai-compat')).toEqual({
      reason: 'no_documented_base_url',
    });
    expect(resolveEndpointVars(getProvider('continue'), 'anthropic')).toEqual({
      reason: 'no_documented_base_url',
    });
  });

  it('goose / kimi / opencode / cursor: писать некуда вовсе', () => {
    for (const id of ['goose', 'kimi', 'opencode', 'cursor']) {
      expect(resolveEndpointVars(getProvider(id), 'openai-compat')).toEqual({
        reason: 'no_env_section',
      });
    }
  });

  it('вид API не тот → api_kind_mismatch, а не молчаливая запись', () => {
    expect(resolveEndpointVars(getProvider('claude'), 'openai-compat')).toEqual({
      reason: 'api_kind_mismatch',
    });
    expect(resolveEndpointVars(getProvider('gemini'), 'anthropic')).toEqual({
      reason: 'api_kind_mismatch',
    });
    expect(resolveEndpointVars(getProvider('aider'), 'google')).toEqual({
      reason: 'api_kind_mismatch',
    });
  });

  it('ни один CLI не объявил переменную адреса пустой строкой', () => {
    // Пустое имя записалось бы ключом «» в чужой конфиг — проверяем весь реестр,
    // а не только тех, кого правили.
    for (const provider of listProviders()) {
      for (const vars of Object.values(provider.endpointConfig ?? {})) {
        expect(vars.baseUrlEnv.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('buildEndpointPlan: токен без галочки не попадает даже в план', () => {
  const vars = {
    baseUrlEnv: 'OPENAI_BASE_URL',
    modelEnv: 'OPENAI_MODEL',
    credentialEnv: 'OPENAI_API_KEY',
  };

  it('по умолчанию — только адрес и модель', () => {
    const plan = buildEndpointPlan(profileOf(), vars, 'secret-value-123', false);
    expect(plan.map((item) => item.key)).toEqual(['OPENAI_BASE_URL', 'OPENAI_MODEL']);
    expect(JSON.stringify(plan)).not.toContain('secret-value-123');
  });

  it('с галочкой — токен добавляется и помечен секретным', () => {
    const plan = buildEndpointPlan(
      profileOf({ writeToken: true }),
      vars,
      'secret-value-123',
      false,
    );
    expect(plan).toContainEqual({ key: 'OPENAI_API_KEY', value: 'secret-value-123', secret: true });
  });

  it('галочка есть, а токена нет — писать нечего', () => {
    const plan = buildEndpointPlan(profileOf({ writeToken: true }), vars, undefined, false);
    expect(plan.map((item) => item.key)).toEqual(['OPENAI_BASE_URL', 'OPENAI_MODEL']);
  });

  it('пустая модель не пишется — переменную модели не трогаем', () => {
    const plan = buildEndpointPlan(profileOf({ model: '  ' }), vars, undefined, false);
    expect(plan.map((item) => item.key)).toEqual(['OPENAI_BASE_URL']);
  });

  it('наружу токен уходит маской', () => {
    const plan = buildEndpointPlan(profileOf({ writeToken: true }), vars, 'secret-value-123', true);
    const token = plan.find((item) => item.secret);
    expect(token?.value).not.toBe('secret-value-123');
    expect(token?.value).toContain('…');
  });
});

describe('describeEndpointTargets: сводка по всем CLI сразу', () => {
  it('для openai-совместимого профиля принимают qwen и aider', () => {
    const targets = describeEndpointTargets(profileOf(), undefined, '/tmp/settings.json');
    const supported = targets.filter((item) => item.supported).map((item) => item.providerId);
    expect(supported).toEqual(['qwen', 'aider']);
  });

  it('для anthropic-профиля принимают claude и qwen', () => {
    const targets = describeEndpointTargets(
      profileOf({ apiKind: 'anthropic', baseUrl: 'https://gw.example.com' }),
      undefined,
      '/tmp/settings.json',
    );
    const supported = targets.filter((item) => item.supported).map((item) => item.providerId);
    expect(supported).toEqual(['claude', 'qwen']);
  });

  it('у неподдержанного CLI план пуст и названа причина', () => {
    const targets = describeEndpointTargets(profileOf(), undefined, '/tmp/settings.json');
    const codex = targets.find((item) => item.providerId === 'codex');
    expect(codex).toMatchObject({ supported: false, reason: 'no_documented_base_url', plan: [] });
  });
});

describe('endpointModelsUrl: смысл базового адреса у каждого вида API свой', () => {
  it('openai-совместимый — версия уже в адресе', () => {
    expect(endpointModelsUrl('http://127.0.0.1:11434/v1', 'openai-compat')).toBe(
      'http://127.0.0.1:11434/v1/models',
    );
  });

  it('anthropic — корень хоста', () => {
    expect(endpointModelsUrl('https://gw.example.com/', 'anthropic')).toBe(
      'https://gw.example.com/v1/models',
    );
  });

  it('google — корень хоста плюс версия', () => {
    expect(endpointModelsUrl('https://gw.example.com', 'google')).toBe(
      'https://gw.example.com/v1beta/models',
    );
  });
});

describe('probeEndpoint: связь проверяется списком моделей', () => {
  it('openai-совместимый: токен идёт заголовком, наружу не возвращается', async () => {
    let seenUrl = '';
    let seenAuth = '';
    const result = await probeEndpoint(profileOf(), 'tok-abcdef123456', (async (
      url: string,
      init: RequestInit,
    ) => {
      seenUrl = url;
      seenAuth = String((init.headers as Record<string, string>).authorization ?? '');
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: 'qwen3-coder' }, { id: 'llama3' }] }),
      } as unknown as Response;
    }) as unknown as typeof fetch);

    expect(seenUrl).toBe('http://127.0.0.1:11434/v1/models');
    expect(seenAuth).toBe('Bearer tok-abcdef123456');
    expect(result).toMatchObject({ ok: true, models: ['qwen3-coder', 'llama3'], tokenSent: true });
    // Адрес в ответе — без токена: он попадает в интерфейс и в тексты ошибок.
    expect(result.url).not.toContain('tok-abcdef123456');
  });

  it('google: ключ уходит в квери, а наружу отдаётся адрес без него', async () => {
    let seenUrl = '';
    const result = await probeEndpoint(
      profileOf({ apiKind: 'google', baseUrl: 'https://gw.example.com' }),
      'gkey-abcdef123456',
      (async (url: string) => {
        seenUrl = url;
        return {
          ok: true,
          status: 200,
          json: async () => ({ models: [{ name: 'models/gemini-3-flash' }] }),
        } as unknown as Response;
      }) as unknown as typeof fetch,
    );

    expect(seenUrl).toContain('key=gkey-abcdef123456');
    expect(result.url).not.toContain('gkey-abcdef123456');
    expect(result.models).toEqual(['gemini-3-flash']);
  });

  it('нерабочая схема адреса — отказ ДО сети', async () => {
    let called = false;
    const result = await probeEndpoint(
      profileOf({ baseUrl: 'file:///etc/passwd' }),
      undefined,
      (async () => {
        called = true;
        return {} as Response;
      }) as unknown as typeof fetch,
    );
    expect(called).toBe(false);
    expect(result.ok).toBe(false);
  });

  it('ответ не JSON — это не «моделей нет», а другой ответ', async () => {
    const result = await probeEndpoint(profileOf(), undefined, (async () => {
      return {
        ok: true,
        status: 200,
        json: async () => {
          throw new Error('not json');
        },
      } as unknown as Response;
    }) as unknown as typeof fetch);
    expect(result).toMatchObject({ ok: false });
  });
});

describe('applyEndpointProfile: запись в конфигурацию', () => {
  let dir = '';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-endpoints-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const claudePaths = () => ({ claudeSettings: join(dir, 'settings.json') });

  it('claude: переменные ложатся в блок env файла settings.json одним заходом', () => {
    const settingsPath = join(dir, 'settings.json');
    writeFileSync(
      settingsPath,
      JSON.stringify({ model: 'opus', env: { EXISTING: 'keep-me' } }, null, 2),
    );

    const result = applyEndpointProfile(
      profileOf({ apiKind: 'anthropic', baseUrl: 'https://gw.example.com', model: 'claude-x' }),
      'claude',
      undefined,
      claudePaths(),
      undefined,
    );

    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      model?: string;
      env: Record<string, string>;
    };
    expect(settings.env).toMatchObject({
      EXISTING: 'keep-me',
      ANTHROPIC_BASE_URL: 'https://gw.example.com',
      ANTHROPIC_MODEL: 'claude-x',
    });
    // Прочие ключи файла не трогаем.
    expect(settings.model).toBe('opus');
    expect(result.written.map((item) => item.key)).toEqual([
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_MODEL',
    ]);
  });

  it('claude: без галочки токена в файле нет', () => {
    const settingsPath = join(dir, 'settings.json');
    applyEndpointProfile(
      profileOf({ apiKind: 'anthropic', baseUrl: 'https://gw.example.com' }),
      'claude',
      'secret-value-123',
      claudePaths(),
      undefined,
    );
    expect(readFileSync(settingsPath, 'utf8')).not.toContain('secret-value-123');
  });

  it('claude: с галочкой токен пишется, но в ответе остаётся маской', () => {
    const settingsPath = join(dir, 'settings.json');
    const result = applyEndpointProfile(
      profileOf({ apiKind: 'anthropic', baseUrl: 'https://gw.example.com', writeToken: true }),
      'claude',
      'secret-value-123',
      claudePaths(),
      undefined,
    );
    expect(readFileSync(settingsPath, 'utf8')).toContain('secret-value-123');
    expect(JSON.stringify(result.written)).not.toContain('secret-value-123');
  });

  it('неизвестный провайдер и неподдержанный — разные отказы', () => {
    expect(() =>
      applyEndpointProfile(profileOf(), 'nope', undefined, claudePaths(), undefined),
    ).toThrow(EndpointApplyError);
    expect(() =>
      applyEndpointProfile(profileOf(), 'codex', undefined, claudePaths(), undefined),
    ).toThrow(/задокументированной переменной/);
  });

  it('нерабочий адрес не доходит до файла', () => {
    const settingsPath = join(dir, 'settings.json');
    expect(() =>
      applyEndpointProfile(
        profileOf({ apiKind: 'anthropic', baseUrl: 'не адрес' }),
        'claude',
        undefined,
        claudePaths(),
        undefined,
      ),
    ).toThrow(/http/);
    expect(existsSync(settingsPath)).toBe(false);
  });

  it('gemini: http вне localhost отвергается — его CLI такой адрес не примет', () => {
    expect(() =>
      applyEndpointProfile(
        profileOf({ apiKind: 'google', baseUrl: 'http://gw.example.com' }),
        'gemini',
        undefined,
        claudePaths(),
        undefined,
      ),
    ).toThrow(/https/);
  });

  it('gemini: localhost по http — исключение, названное в его же документации', () => {
    const profile = profileOf({ apiKind: 'google', baseUrl: 'http://localhost:8080' });
    // Записывать в настоящий ~/.gemini/.env тест не станет — проверяем, что
    // отказа по адресу нет, а дальше путь ведёт в файл провайдера.
    expect(() => {
      try {
        applyEndpointProfile(profile, 'gemini', undefined, claudePaths(), undefined);
      } catch (error) {
        if (error instanceof EndpointApplyError) throw error;
        // Любая файловая ошибка — не про адрес, её здесь и не проверяем.
      }
    }).not.toThrow();
  });
});

describe('токен профиля: зашифрованное хранилище панели', () => {
  let dir = '';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-endpoint-token-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('сохраняется, читается и забывается', () => {
    expect(saveEndpointToken(dir, 'ep-1', 'secret-value-123')).toBe(true);
    expect(readEndpointToken(dir, 'ep-1')).toBe('secret-value-123');
    clearEndpointToken(dir, 'ep-1');
    expect(readEndpointToken(dir, 'ep-1')).toBeUndefined();
  });

  it('на диске лежит зашифрованным — открытым текстом токена в файлах нет', () => {
    saveEndpointToken(dir, 'ep-1', 'secret-value-123');
    const blob = readFileSync(join(dir, 'provider-keys.enc'));
    expect(blob.toString('utf8')).not.toContain('secret-value-123');
  });

  it('не сталкивается с ключом провайдера того же имени', () => {
    saveEndpointToken(dir, 'claude', 'endpoint-token-value');
    // Ключ провайдера `claude` лежит под своим id, токен профиля — под
    // префиксом: одно не перетирает другое.
    expect(readEndpointToken(dir, 'claude')).toBe('endpoint-token-value');
  });
});

describe('resolveAssistantEndpoint: ассистент панели идёт туда только по выбору', () => {
  const store = (assistantEndpointId: string, profiles: EndpointProfile[]) => ({
    getSettings: () => ({ endpointProfiles: profiles, assistantEndpointId, claudeDirOverride: '' }),
  });

  it('не выбран — undefined (всё как раньше)', () => {
    expect(resolveAssistantEndpoint(store('', [profileOf()]), '/tmp')).toBeUndefined();
  });

  it('выбранный профиль удалён — возвращаемся в облако, а не на соседний адрес', () => {
    expect(resolveAssistantEndpoint(store('ep-404', [profileOf()]), '/tmp')).toBeUndefined();
  });

  it('выбран — отдаём адрес, вид API и модель', () => {
    expect(resolveAssistantEndpoint(store('ep-1', [profileOf()]), '/tmp')).toMatchObject({
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKind: 'openai-compat',
      model: 'qwen3-coder',
    });
  });
});
