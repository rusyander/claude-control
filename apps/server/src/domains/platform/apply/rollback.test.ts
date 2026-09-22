import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { defaultOurRules, defaultPlatformRules } from '@agentdeck/contracts/platform';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import type { Platform } from '@agentdeck/contracts';
import { AppStore } from '../../../lib/app-store.ts';
import { applyContour } from './apply.ts';
import { buildPlatformApplyPlan, type ContourApplyDeps } from './plan.ts';
import { rollbackContour } from './rollback.ts';
import { applyCodexEndpoint, rollbackCodexEndpoint } from './config-files.ts';
import { defaultPlatformTransport } from '@agentdeck/contracts/platform-transport';

/**
 * Снятие применения — вторая половина обещания контура: то, что панель
 * записала, панель и уберёт.
 *
 * Главное здесь — граница чужой работы. Файл, который человек правил ПОСЛЕ
 * применения, откат не трогает вовсе и называет его; файла, который человек
 * удалил, откат не воскрешает. Затереть чужую правку «ради чистоты» — худший
 * из возможных исходов, и именно он здесь заперт.
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
  // Откат проверяется после применения, а применение (Т3) идёт только при
  // включённых потребителях — иначе снимать было бы нечего.
  consumers: ['assistant', 'terminal'],
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

const CODEX_CONFIG = `# личные настройки codex
model = "o3"

[model_providers.own]
base_url = "https://свой.local/v1"

[mcp_servers.local]
command = "npx"
`;

const CONTINUE_CONFIG = `name: my assistant
models:
  - name: моя модель
    provider: openai
    model: gpt-4o
    apiBase: https://свой.local/v1
`;

const HOME_VARS = ['HOME', 'USERPROFILE', 'CODEX_HOME', 'QWEN_HOME', 'XDG_CONFIG_HOME'];

let root: string;
let home: string;
let settingsPath: string;
let codexPath: string;
let continuePath: string;
let store: AppStore;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-contour-rollback-'));
  home = join(root, 'home');
  settingsPath = join(root, 'claude', 'settings.json');
  codexPath = join(home, '.codex', 'config.toml');
  continuePath = join(home, '.continue', 'config.yaml');
  mkdirSync(join(root, 'agentdeck'), { recursive: true });
  mkdirSync(join(root, 'claude'), { recursive: true });
  mkdirSync(join(home, '.codex'), { recursive: true });
  mkdirSync(join(home, '.continue'), { recursive: true });

  saved = Object.fromEntries(HOME_VARS.map((name) => [name, process.env[name]]));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.CODEX_HOME = join(home, '.codex');
  process.env.QWEN_HOME = join(home, '.qwen');
  process.env.XDG_CONFIG_HOME = join(home, '.config');

  store = new AppStore(join(root, 'agentdeck'));
  store.updateSettings({
    platforms: [PLATFORM],
    platformGateway: { enabled: true, port: 5179, forceStream: true },
  });
});

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

const deps = (): ContourApplyDeps => ({
  store,
  paths: { claudeSettings: settingsPath },
  backupDir: join(root, 'backups'),
  gatewayRunning: true,
});

const targetOf = (plan: ReturnType<typeof buildPlatformApplyPlan>, id: string) =>
  plan.targets.find((item) => item.targetId === id)!;

const outcomeOf = (entries: { targetId: string; outcome: string }[], id: string): string =>
  entries.find((item) => item.targetId === id)?.outcome ?? 'нет такой цели';

describe('возврат файлов в исходное состояние', () => {
  it('claude: наши ключи убраны, чужие переменные на месте', () => {
    const original = JSON.stringify({ model: 'opus', env: { EXISTING: 'keep-me' } }, null, 2);
    writeFileSync(settingsPath, original);

    applyContour(deps(), PLATFORM, { targets: ['claude'], model: 'gpt-4o' });
    const result = rollbackContour(deps(), PLATFORM.id);

    expect(outcomeOf(result.entries, 'claude')).toBe('restored');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      model: string;
      env: Record<string, string>;
    };
    expect(settings).toEqual({ model: 'opus', env: { EXISTING: 'keep-me' } });
  });

  it('claude: переменная, которая СТОЯЛА до нас, возвращается со своим значением', () => {
    writeFileSync(settingsPath, JSON.stringify({ env: { ANTHROPIC_MODEL: 'opus' } }));
    applyContour(deps(), PLATFORM, {
      targets: ['claude'],
      overwrite: ['claude'],
      model: 'gpt-4o',
    });
    rollbackContour(deps(), PLATFORM.id);

    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      env: Record<string, string>;
    };
    // Не «убрали всё, что писали», а «вернули как было»: разница видна ровно
    // здесь, и без неё откат уносил бы чужую настройку.
    expect(settings.env).toEqual({ ANTHROPIC_MODEL: 'opus' });
  });

  it('codex: своя таблица ушла, чужие и корневой ключ целы', () => {
    // Писатель и откат проверяются НАПРЯМУЮ: целью контура codex сегодня не
    // предлагается (его ручку шлюз не обслуживает, `targets.ts`), но хирургия по
    // чужому TOML обязана оставаться верной к моменту, когда маршрут появится.
    writeFileSync(codexPath, CODEX_CONFIG);
    const name = 'contour-company-dev';
    const written = applyCodexEndpoint(
      codexPath,
      name,
      'http://127.0.0.1:5179/company-dev/v1',
      undefined,
      'responses',
    );
    expect(readFileSync(codexPath, 'utf8')).toContain(`[model_providers.${name}]`);

    rollbackCodexEndpoint(
      codexPath,
      name,
      {
        targetId: 'codex',
        filePath: codexPath,
        appliedAt: '2026-09-22T00:00:00.000Z',
        fingerprint: '',
        ...written,
      },
      undefined,
    );

    const text = readFileSync(codexPath, 'utf8');
    expect(text).not.toContain('contour-company-dev');
    expect(text).toContain('[model_providers.own]');
    expect(text).toContain('[mcp_servers.local]');
    expect(text).toContain('# личные настройки codex');
    // Корневой выбор провайдера панель поставила сама — значит и убрать обязана.
    expect(text).not.toContain('model_provider = ');
  });

  it('continue: своя запись ушла из списка моделей, чужая осталась', () => {
    writeFileSync(continuePath, CONTINUE_CONFIG);
    applyContour(deps(), PLATFORM, { targets: ['continue'], model: 'gpt-4o' });
    rollbackContour(deps(), PLATFORM.id);

    const parsed = parseYaml(readFileSync(continuePath, 'utf8')) as {
      name: string;
      models: { name: string }[];
    };
    expect(parsed.name).toBe('my assistant');
    expect(parsed.models.map((item) => item.name)).toEqual(['моя модель']);
  });

  it('несколько целей разом — все названы в ответе', () => {
    writeFileSync(settingsPath, JSON.stringify({ env: {} }));
    writeFileSync(continuePath, CONTINUE_CONFIG);
    applyContour(deps(), PLATFORM, {
      targets: ['assistant', 'claude', 'continue'],
      model: 'gpt-4o',
    });

    const result = rollbackContour(deps(), PLATFORM.id);
    expect(result.entries.map((item) => item.targetId)).toEqual([
      'assistant',
      'claude',
      'continue',
    ]);
    expect(result.entries.every((item) => item.outcome === 'restored')).toBe(true);
  });
});

describe('точечный откат', () => {
  it('снимается названная цель, остальные остаются применёнными', () => {
    writeFileSync(settingsPath, JSON.stringify({ env: { EXISTING: 'keep-me' } }));
    writeFileSync(continuePath, CONTINUE_CONFIG);
    applyContour(deps(), PLATFORM, { targets: ['claude', 'continue'], model: 'gpt-4o' });

    const result = rollbackContour(deps(), PLATFORM.id, { targetIds: ['claude'] });

    expect(result.entries.map((item) => item.targetId)).toEqual(['claude']);
    expect(outcomeOf(result.entries, 'claude')).toBe('restored');
    // Continue не тронут ни в файле, ни в следе: человек передумал про один CLI,
    // а не про весь контур.
    expect(readFileSync(continuePath, 'utf8')).toContain('contour-company-dev');
    expect(store.getPlatformApplied()[PLATFORM.id]?.targets.map((item) => item.targetId)).toEqual([
      'continue',
    ]);
  });

  it('пока в следе есть цели, управляемый профиль живёт — на него смотрят они', () => {
    writeFileSync(settingsPath, JSON.stringify({ env: {} }));
    writeFileSync(continuePath, CONTINUE_CONFIG);
    applyContour(deps(), PLATFORM, { targets: ['claude', 'continue'], model: 'gpt-4o' });

    const result = rollbackContour(deps(), PLATFORM.id, { targetIds: ['claude'] });
    expect(result.profileRemoved).toBe(false);
    expect(store.getSettings().endpointProfiles.map((item) => item.id)).toEqual([
      'contour-company-dev',
    ]);
  });

  it('снятие последней цели уносит и профиль, и след', () => {
    writeFileSync(settingsPath, JSON.stringify({ env: {} }));
    applyContour(deps(), PLATFORM, { targets: ['claude'], model: 'gpt-4o' });

    const result = rollbackContour(deps(), PLATFORM.id, { targetIds: ['claude'] });
    expect(result.profileRemoved).toBe(true);
    expect(store.getPlatformApplied()[PLATFORM.id]).toBeUndefined();
  });

  it('цель, которую откат не смог тронуть, из следа тоже уходит', () => {
    writeFileSync(settingsPath, JSON.stringify({ env: {} }));
    writeFileSync(continuePath, CONTINUE_CONFIG);
    applyContour(deps(), PLATFORM, { targets: ['claude', 'continue'], model: 'gpt-4o' });
    writeFileSync(settingsPath, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'моё' } }));

    const result = rollbackContour(deps(), PLATFORM.id, { targetIds: ['claude'] });
    expect(outcomeOf(result.entries, 'claude')).toBe('kept');
    // Вернуть её мы уже не сможем никогда — отпечаток не сойдётся, — и запись,
    // обещающая откат, которого нет, хуже её отсутствия.
    expect(store.getPlatformApplied()[PLATFORM.id]?.targets.map((item) => item.targetId)).toEqual([
      'continue',
    ]);
  });

  it('снятие CLI не возвращает ассистента к прежнему профилю', () => {
    const own = {
      id: 'ep-1',
      name: 'Локальная модель',
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKind: 'openai-compat' as const,
      model: '',
      writeToken: false,
      imagesUrl: '',
      ownerPlatformId: '',
    };
    store.updateSettings({ endpointProfiles: [own], assistantEndpointId: 'ep-1' });
    writeFileSync(settingsPath, JSON.stringify({ env: {} }));
    applyContour(deps(), PLATFORM, {
      targets: ['assistant', 'claude'],
      overwrite: ['assistant'],
      model: 'gpt-4o',
    });

    rollbackContour(deps(), PLATFORM.id, { targetIds: ['claude'] });
    // Ассистента никто не снимал — он и остаётся на контуре.
    expect(store.getSettings().assistantEndpointId).toBe('contour-company-dev');
  });

  it('названа цель, которой в следе нет — не трогается ничего', () => {
    writeFileSync(settingsPath, JSON.stringify({ env: {} }));
    applyContour(deps(), PLATFORM, { targets: ['claude'], model: 'gpt-4o' });

    const result = rollbackContour(deps(), PLATFORM.id, { targetIds: ['qwen'] });
    expect(result).toEqual({ entries: [], profileRemoved: false });
    expect(store.getPlatformApplied()[PLATFORM.id]?.targets.map((item) => item.targetId)).toEqual([
      'claude',
    ]);
  });
});

describe('чужая работа', () => {
  /**
   * Аудит DRV-02. `settings.json` пишет не одно применение: права, хуки и
   * переменные панели ложатся в тот же файл. Отпечаток ВСЕГО файла объявлял
   * «чужой рукой» любую такую правку — откат уходил в `kept`, след стирался, и
   * Claude оставался направленным на шлюз без единого способа это снять.
   */
  it('claude: правка ДРУГИХ ключей после применения откату не мешает и переживает его', () => {
    writeFileSync(settingsPath, JSON.stringify({ env: { EXISTING: 'keep-me' } }));
    applyContour(deps(), PLATFORM, { targets: ['claude'], model: 'gpt-4o' });

    // Ровно то, что делают разделы «Права» и «Переменные» панели.
    const after = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown> & {
      env: Record<string, string>;
    };
    after.permissions = { allow: ['Bash(git status)'] };
    after.env = { ...after.env, MY_OWN: 'добавлено после' };
    writeFileSync(settingsPath, JSON.stringify(after, null, 2));

    expect(targetOf(buildPlatformApplyPlan(deps(), PLATFORM), 'claude').drifted).toBeUndefined();
    const result = rollbackContour(deps(), PLATFORM.id);
    expect(outcomeOf(result.entries, 'claude')).toBe('restored');
    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({
      env: { EXISTING: 'keep-me', MY_OWN: 'добавлено после' },
      permissions: { allow: ['Bash(git status)'] },
    });
  });

  it('claude: правка НАШЕГО ключа — расхождение, и откат его не трогает', () => {
    writeFileSync(settingsPath, JSON.stringify({ env: {} }));
    applyContour(deps(), PLATFORM, { targets: ['claude'], model: 'gpt-4o' });
    const after = JSON.parse(readFileSync(settingsPath, 'utf8')) as { env: Record<string, string> };
    after.env.ANTHROPIC_MODEL = 'моя-модель';
    const mine = JSON.stringify(after);
    writeFileSync(settingsPath, mine);

    expect(targetOf(buildPlatformApplyPlan(deps(), PLATFORM), 'claude').drifted).toBe(true);
    expect(outcomeOf(rollbackContour(deps(), PLATFORM.id).entries, 'claude')).toBe('kept');
    expect(readFileSync(settingsPath, 'utf8')).toBe(mine);
  });

  it('continue: правка чужой записи после применения откату не мешает', () => {
    // Вторая файловая цель занимает здесь место codex: правится регион, а не
    // файл целиком, и чужая строка обязана пережить откат.
    writeFileSync(continuePath, CONTINUE_CONFIG);
    applyContour(deps(), PLATFORM, { targets: ['continue'], model: 'gpt-4o' });
    writeFileSync(
      continuePath,
      readFileSync(continuePath, 'utf8').replace('my assistant', 'мой помощник'),
    );

    const result = rollbackContour(deps(), PLATFORM.id);
    expect(outcomeOf(result.entries, 'continue')).toBe('restored');
    const text = readFileSync(continuePath, 'utf8');
    expect(text).not.toContain('contour-company-dev');
    expect(text).toContain('мой помощник');
  });

  it('файл, изменённый человеком после применения, не затирается — он назван', () => {
    writeFileSync(settingsPath, JSON.stringify({ env: {} }));
    applyContour(deps(), PLATFORM, { targets: ['claude'], model: 'gpt-4o' });

    const mine = JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'мой-собственный-шлюз' } });
    writeFileSync(settingsPath, mine);

    const result = rollbackContour(deps(), PLATFORM.id);
    expect(outcomeOf(result.entries, 'claude')).toBe('kept');
    // Правка человека переживает откат целиком: дальше решает он.
    expect(readFileSync(settingsPath, 'utf8')).toBe(mine);
  });

  it('файла больше нет — откат его не воскрешает', () => {
    writeFileSync(settingsPath, JSON.stringify({ env: {} }));
    applyContour(deps(), PLATFORM, { targets: ['claude'], model: 'gpt-4o' });
    rmSync(settingsPath);

    const result = rollbackContour(deps(), PLATFORM.id);
    expect(outcomeOf(result.entries, 'claude')).toBe('missing');
  });

  it('ассистента увели на свой профиль — выбор человека сохраняется', () => {
    applyContour(deps(), PLATFORM, { targets: ['assistant'] });
    store.updateSettings({ assistantEndpointId: 'ep-своё' });

    const result = rollbackContour(deps(), PLATFORM.id);
    expect(outcomeOf(result.entries, 'assistant')).toBe('kept');
    expect(store.getSettings().assistantEndpointId).toBe('ep-своё');
  });
});

describe('профиль и ассистент', () => {
  const own = {
    id: 'ep-1',
    name: 'Локальная модель',
    baseUrl: 'http://127.0.0.1:11434/v1',
    apiKind: 'openai-compat' as const,
    model: '',
    writeToken: false,
    imagesUrl: '',
    ownerPlatformId: '',
  };

  it('управляемый профиль удаляется, а ассистент возвращается к прежнему', () => {
    store.updateSettings({ endpointProfiles: [own], assistantEndpointId: 'ep-1' });
    applyContour(deps(), PLATFORM, { targets: ['assistant'], overwrite: ['assistant'] });
    expect(store.getSettings().assistantEndpointId).toBe('contour-company-dev');

    const result = rollbackContour(deps(), PLATFORM.id);
    expect(result.profileRemoved).toBe(true);
    expect(store.getSettings().endpointProfiles).toEqual([own]);
    expect(store.getSettings().assistantEndpointId).toBe('ep-1');
  });

  it('прежний профиль успели удалить — ассистент возвращается в облако вендора', () => {
    store.updateSettings({ endpointProfiles: [own], assistantEndpointId: 'ep-1' });
    applyContour(deps(), PLATFORM, { targets: ['assistant'], overwrite: ['assistant'] });
    store.updateSettings({
      endpointProfiles: store.getSettings().endpointProfiles.filter((item) => item.id !== 'ep-1'),
    });

    rollbackContour(deps(), PLATFORM.id);
    // Указывать на профиль, которого нет, — это молча неработающий ассистент.
    expect(store.getSettings().assistantEndpointId).toBe('');
  });

  it('след уходит вместе с применением', () => {
    writeFileSync(settingsPath, JSON.stringify({ env: {} }));
    applyContour(deps(), PLATFORM, { targets: ['claude'] });
    rollbackContour(deps(), PLATFORM.id);
    expect(store.getPlatformApplied()['company-dev']).toBeUndefined();
  });

  it('применения не было — откат ничего не выдумывает', () => {
    const result = rollbackContour(deps(), PLATFORM.id);
    expect(result).toEqual({ entries: [], profileRemoved: false });
  });

  it('след потерян, а профиль остался — профиль всё равно уходит', () => {
    applyContour(deps(), PLATFORM, { targets: ['assistant'] });
    store.forgetPlatformApplied(PLATFORM.id);

    const result = rollbackContour(deps(), PLATFORM.id);
    // Он указывает на маршрут шлюза, которым больше никто не управляет.
    expect(result.profileRemoved).toBe(true);
    expect(store.getSettings().assistantEndpointId).toBe('');
  });
});
