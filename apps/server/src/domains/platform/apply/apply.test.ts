import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Platform } from '@agentdeck/contracts';
import { AppStore } from '../../../lib/app-store.ts';
import { buildHistory } from '../../history.ts';
import { claudeTrackedFiles } from '../../tracked-files.ts';
import { writeToken } from '../store.ts';
import { PlatformError } from '../errors.ts';
import { applyContour } from './apply.ts';
import { type ContourApplyDeps } from './plan.ts';
import { PLACEHOLDER_KEY } from './profile.ts';

/**
 * Применение контура — приёмка Т3 целиком.
 *
 * Проверяется то, за что человек будет держать панель ответственной: ассистент
 * не трогает ни одного чужого файла, у claude появляются ровно нужные ключи и
 * копия файла, TOML codex остаётся побайтно целым вне своего региона, занятое
 * место не перебивается молча — и НИ В ОДИН файл не попадает настоящий ключ
 * контура. Последнее проверяется перебором: ключ лежит в шифрохранилище,
 * применяются все поддержанные цели, и весь домашний каталог обыскивается.
 */

/** Латиница обязательна: ключ вне печатного ASCII панель не сохраняет (Т12). */
const SECRET = 'CONTOUR-KEY-ORG-4f21';

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
  // Оба потребителя применения включены (Т3): без них `apply` законно
  // отказывает каждой цели с причиной `consumer_off`, и здесь проверялся бы
  // отказ, а не запись в файлы.
  consumers: ['assistant', 'terminal'],
  agents: [],
  budgetSince: '',
  toolShim: true,
  contourPrompt: true,
  caCertPath: '',
};

/** Живой config.toml codex: MCP, окружение, права, комментарии — всё чужое. */
const CODEX_CONFIG = `# личные настройки codex
model = "o3"
approval_policy = "on-request"

[shell_environment_policy]
inherit = "core"

[shell_environment_policy.set]
MY_VAR = "keep-me"

[mcp_servers.local]
command = "npx"
args = ["-y", "pkg"]
`;

const HOME_VARS = ['HOME', 'USERPROFILE', 'CODEX_HOME', 'QWEN_HOME', 'XDG_CONFIG_HOME'];

let root: string;
let home: string;
let appData: string;
let backupDir: string;
let settingsPath: string;
let store: AppStore;
let saved: Record<string, string | undefined>;

/** Все файлы под домашним каталогом — тем самым, куда пишут CLI. */
function walk(dir: string): string[] {
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-contour-apply-'));
  home = join(root, 'home');
  appData = join(root, 'agentdeck');
  backupDir = join(root, 'backups');
  settingsPath = join(root, 'claude', 'settings.json');
  mkdirSync(appData, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(join(root, 'claude'), { recursive: true });

  // Домашний каталог подменяется целиком: цели вроде continue и aider живут
  // прямо в нём, и тест обязан писать в свой, а не в настоящий.
  saved = Object.fromEntries(HOME_VARS.map((name) => [name, process.env[name]]));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.CODEX_HOME = join(home, '.codex');
  process.env.QWEN_HOME = join(home, '.qwen');
  process.env.XDG_CONFIG_HOME = join(home, '.config');

  store = new AppStore(appData);
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
  backupDir,
  gatewayRunning: true,
});

describe('ассистент панели', () => {
  it('применение к ассистенту не трогает ни одного файла CLI', () => {
    const before = walk(home);
    const result = applyContour(deps(), PLATFORM, { targets: ['assistant'], model: 'gpt-4o' });

    expect(result.applied).toEqual([{ targetId: 'assistant', filePath: '', written: [] }]);
    expect(result.skipped).toEqual([]);
    // Ассистент живёт в настройках панели: ни одного нового файла в домашнем
    // каталоге появиться не может.
    expect(walk(home)).toEqual(before);
    expect(store.getSettings().assistantEndpointId).toBe('contour-enterprise-platform-dev');
  });

  it('управляемый профиль появляется в общем списке эндпоинтов', () => {
    applyContour(deps(), PLATFORM, { targets: ['assistant'], model: 'gpt-4o' });
    const profile = store
      .getSettings()
      .endpointProfiles.find((item) => item.id === 'contour-enterprise-platform-dev');
    expect(profile).toMatchObject({
      baseUrl: 'http://127.0.0.1:5179/enterprise-platform-dev/v1',
      model: 'gpt-4o',
      ownerPlatformId: 'enterprise-platform-dev',
      writeToken: false,
    });
  });

  it('прежний выбор ассистента запоминается — откату будет куда вернуться', () => {
    store.updateSettings({ assistantEndpointId: 'ep-1' });
    // Занятое место у ассистента — это его собственный выбор профиля, и без
    // явного согласия контур его не перебивает.
    applyContour(deps(), PLATFORM, { targets: ['assistant'], overwrite: ['assistant'] });
    expect(store.getPlatformApplied()['enterprise-platform-dev']?.previousAssistantProfileId).toBe('ep-1');
  });

  it('чужой выбор ассистента без согласия не перебивается', () => {
    store.updateSettings({ assistantEndpointId: 'ep-1' });
    const result = applyContour(deps(), PLATFORM, { targets: ['assistant'] });
    expect(result.skipped).toEqual([{ targetId: 'assistant', reason: 'conflict' }]);
    expect(store.getSettings().assistantEndpointId).toBe('ep-1');
  });
});

describe('claude', () => {
  it('в блок env ложатся ровно нужные ключи, чужие переменные целы, копия создана', () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({ model: 'opus', env: { EXISTING: 'keep-me' } }, null, 2),
    );

    const result = applyContour(deps(), PLATFORM, { targets: ['claude'], model: 'gpt-4o' });
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      model: string;
      env: Record<string, string>;
    };

    expect(settings.env).toEqual({
      EXISTING: 'keep-me',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:5179/enterprise-platform-dev',
      ANTHROPIC_MODEL: 'gpt-4o',
      ANTHROPIC_AUTH_TOKEN: PLACEHOLDER_KEY,
    });
    // Богатый раздел настроек самого Claude не трогается ни на строку.
    expect(settings.model).toBe('opus');

    // Копия — то же, что показывает History: правка панели обязана быть
    // отменяемой руками, а не только нашим откатом.
    const backupPath = result.applied[0]?.backupPath;
    expect(backupPath).toBeDefined();
    expect(JSON.parse(readFileSync(backupPath!, 'utf8'))).toEqual({
      model: 'opus',
      env: { EXISTING: 'keep-me' },
    });
  });

  it('правка видна в History — той же лентой, что читает человек', () => {
    writeFileSync(settingsPath, JSON.stringify({ env: { EXISTING: 'keep-me' } }, null, 2));
    applyContour(deps(), PLATFORM, { targets: ['claude'], model: 'gpt-4o' });

    // Лента собирается из копий по СПИСКУ ведомых файлов: копия, которую этот
    // список не знает, в History не попадает вовсе — значит проверять надо
    // именно так, а не существованием файла копии.
    const targets = claudeTrackedFiles({
      settings: settingsPath,
      settingsLocal: join(root, 'claude', 'settings.local.json'),
      claudeMd: join(root, 'claude', 'CLAUDE.md'),
      mcpConfig: join(root, 'claude', '.claude.json'),
    } as never);
    const entries = buildHistory(join(root, 'backups'), targets);
    expect(entries.map((item) => item.file)).toContain('settings.json');
    expect(entries[0]?.added).toBeGreaterThan(0);
  });

  it('след применения помнит, чего в файле НЕ БЫЛО', () => {
    writeFileSync(settingsPath, JSON.stringify({ env: { ANTHROPIC_MODEL: 'opus' } }));
    applyContour(deps(), PLATFORM, { targets: ['claude'], model: 'gpt-4o' });

    const trace = store.getPlatformApplied()['enterprise-platform-dev']?.targets[0];
    expect(trace?.previous).toEqual([
      { key: 'ANTHROPIC_BASE_URL' },
      { key: 'ANTHROPIC_MODEL', value: 'opus' },
      { key: 'ANTHROPIC_AUTH_TOKEN' },
    ]);
    expect(trace?.fingerprint).not.toBe('');
  });

  it('повтор применения не выдаёт наши значения за прежние', () => {
    writeFileSync(settingsPath, JSON.stringify({ env: { ANTHROPIC_MODEL: 'opus' } }));
    applyContour(deps(), PLATFORM, { targets: ['claude'], model: 'gpt-4o' });
    applyContour(deps(), PLATFORM, { targets: ['claude'], model: 'gpt-4o' });

    // Иначе откат вернул бы файл в состояние, которое панель сама и сделала, —
    // то есть не вернул бы никуда.
    expect(store.getPlatformApplied()['enterprise-platform-dev']?.targets[0]?.previous).toEqual([
      { key: 'ANTHROPIC_BASE_URL' },
      { key: 'ANTHROPIC_MODEL', value: 'opus' },
      { key: 'ANTHROPIC_AUTH_TOKEN' },
    ]);
  });
});

describe('codex', () => {
  it('правится только регион model_providers — остальной TOML цел', () => {
    const configPath = join(home, '.codex', 'config.toml');
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(configPath, CODEX_CONFIG);

    applyContour(deps(), PLATFORM, { targets: ['codex'], model: 'gpt-4o' });
    const text = readFileSync(configPath, 'utf8');

    // Комментарий, чужие таблицы и их содержимое — байт в байт.
    expect(text).toContain('# личные настройки codex');
    expect(text).toContain('[shell_environment_policy.set]\nMY_VAR = "keep-me"');
    expect(text).toContain('[mcp_servers.local]\ncommand = "npx"');
    expect(text).toContain('model = "o3"');
    expect(text).toContain('approval_policy = "on-request"');

    expect(text).toContain('[model_providers.contour-enterprise-platform-dev]');
    expect(text).toContain('base_url = "http://127.0.0.1:5179/enterprise-platform-dev/v1"');
    // Корневой выбор провайдера — иначе запись мертва.
    expect(text).toContain('model_provider = "contour-enterprise-platform-dev"');
  });

  it('прежний выбор провайдера сохраняется в следе', () => {
    const configPath = join(home, '.codex', 'config.toml');
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(configPath, 'model_provider = "openai"\n');

    // Уже выбранный провайдер — занятое место, и перебивается он только по
    // явному согласию; в след при этом уходит прежнее имя.
    applyContour(deps(), PLATFORM, { targets: ['codex'], overwrite: ['codex'] });
    expect(store.getPlatformApplied()['enterprise-platform-dev']?.targets[0]?.previous).toEqual([
      { key: 'model_provider', value: 'openai' },
    ]);
  });
});

describe('занятое место и неподдержанные цели', () => {
  it('конфликт без явного выбора — цель пропущена, файл не тронут', () => {
    writeFileSync(settingsPath, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'свой-шлюз' } }));
    const before = readFileSync(settingsPath, 'utf8');

    const result = applyContour(deps(), PLATFORM, { targets: ['claude'] });
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([{ targetId: 'claude', reason: 'conflict' }]);
    expect(readFileSync(settingsPath, 'utf8')).toBe(before);
    // Пропущенная цель не оставляет следа: откатывать нечего.
    expect(store.getPlatformApplied()['enterprise-platform-dev']).toBeUndefined();
  });

  it('названная в overwrite цель перебивается — но только она', () => {
    writeFileSync(settingsPath, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'свой-шлюз' } }));
    const result = applyContour(deps(), PLATFORM, {
      targets: ['claude'],
      overwrite: ['claude'],
    });
    expect(result.skipped).toEqual([]);
    expect(
      (JSON.parse(readFileSync(settingsPath, 'utf8')) as { env: Record<string, string> }).env
        .ANTHROPIC_BASE_URL,
    ).toBe('http://127.0.0.1:5179/enterprise-platform-dev');
  });

  it('цель с прочерком пропускается со СВОЕЙ причиной', () => {
    const result = applyContour(deps(), PLATFORM, { targets: ['gemini', 'goose'] });
    expect(result.skipped).toEqual([
      { targetId: 'gemini', reason: 'gateway_dialect' },
      { targetId: 'goose', reason: 'no_env_section' },
    ]);
  });

  it('погашенный шлюз не пишет ничего', () => {
    const result = applyContour({ ...deps(), gatewayRunning: false }, PLATFORM, {
      targets: ['claude'],
    });
    expect(result.skipped).toEqual([{ targetId: 'claude', reason: 'gateway_down' }]);
    expect(walk(home)).toEqual([]);
  });

  it('задуманный порт занят — в файл уходит ДОСТАВШИЙСЯ, а не настроенный', () => {
    // Слушатель, не сумевший занять 5179, берёт соседний и записывает его в
    // состояние. Адрес из настроек в этот момент указывал бы на чужой процесс,
    // который 5179 и занял: CLI ушёл бы с корпоративным запросом к нему.
    store.setPlatformGatewayPort(5180);

    const result = applyContour(deps(), PLATFORM, { targets: ['claude', 'assistant'] });
    expect(result.skipped).toEqual([]);
    expect(
      (JSON.parse(readFileSync(settingsPath, 'utf8')) as { env: Record<string, string> }).env
        .ANTHROPIC_BASE_URL,
    ).toBe('http://127.0.0.1:5180/enterprise-platform-dev');
    expect(
      store.getSettings().endpointProfiles.find((item) => item.id === 'contour-enterprise-platform-dev')
        ?.baseUrl,
    ).toBe('http://127.0.0.1:5180/enterprise-platform-dev/v1');
  });

  it('незнакомая цель — отказ с именем поля, а не молчаливый пропуск', () => {
    expect(() => applyContour(deps(), PLATFORM, { targets: ['нет-такого'] })).toThrow(
      PlatformError,
    );
  });

  it('снятый «Терминал» — файл CLI не тронут, отказ назван потребителем', () => {
    // Правило Т3 со стороны сервера. Экран и без него не прислал бы цель, но
    // дверь в применение одна на всех — телефон и API-клиент ходят в неё же.
    const noTerminal = { ...PLATFORM, consumers: ['assistant'] };
    const result = applyContour(deps(), noTerminal, { targets: ['claude', 'assistant'] });

    expect(result.skipped).toEqual([{ targetId: 'claude', reason: 'consumer_off' }]);
    expect(result.applied).toEqual([{ targetId: 'assistant', filePath: '', written: [] }]);
    expect(statSync(settingsPath, { throwIfNoEntry: false })).toBeUndefined();
  });

  it('снятый «Ассистент панели» — настройка ассистента не переезжает на контур', () => {
    const noAssistant = { ...PLATFORM, consumers: ['terminal'] };
    const result = applyContour(deps(), noAssistant, { targets: ['assistant'] });

    expect(result.skipped).toEqual([{ targetId: 'assistant', reason: 'consumer_off' }]);
    expect(store.getSettings().assistantEndpointId).toBe('');
  });
});

describe('ключ контура', () => {
  it('не попадает НИ В ОДИН файл — перебором всех поддержанных целей', () => {
    // Ключ лежит там, где ему и место: в шифрохранилище панели.
    writeToken(appData, PLATFORM.id, SECRET);

    const targets = ['assistant', 'claude', 'qwen', 'aider', 'codex', 'continue'];
    const result = applyContour(deps(), PLATFORM, { targets, model: 'gpt-4o' });
    expect(result.applied.map((item) => item.targetId)).toEqual(targets);

    const files = [...walk(home), ...walk(join(root, 'claude')), ...walk(backupDir)];
    expect(files.length).toBeGreaterThan(4);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect(text).not.toContain(SECRET);
      // И по куску тоже: обрезанный ключ в файле — та же утечка.
      expect(text).not.toContain('CONTOUR-KEY-ORG');
    }

    // Заглушка при этом на месте: CLI, который не стартует с пустой
    // переменной, обязан её получить.
    const claudeEnv = (
      JSON.parse(readFileSync(settingsPath, 'utf8')) as { env: Record<string, string> }
    ).env;
    expect(claudeEnv.ANTHROPIC_AUTH_TOKEN).toBe(PLACEHOLDER_KEY);
  });

  it('и в ответе применения его тоже нет', () => {
    writeToken(appData, PLATFORM.id, SECRET);
    const result = applyContour(deps(), PLATFORM, {
      targets: ['claude', 'codex'],
      model: 'gpt-4o',
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});
