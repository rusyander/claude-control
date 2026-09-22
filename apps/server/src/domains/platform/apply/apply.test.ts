import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { defaultOurRules, defaultPlatformRules } from '@agentdeck/contracts/platform';
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
import { writePlatform, writeToken } from '../store.ts';
import { PlatformError } from '../errors.ts';
import { applyContour } from './apply.ts';
import { applyCodexEndpoint } from './config-files.ts';
import { type ContourApplyDeps } from './plan.ts';
import { PLACEHOLDER_KEY } from './profile.ts';
import { defaultPlatformTransport } from '@agentdeck/contracts/platform-transport';

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
  // Оба потребителя применения включены (Т3): без них `apply` законно
  // отказывает каждой цели с причиной `consumer_off`, и здесь проверялся бы
  // отказ, а не запись в файлы.
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
    expect(store.getSettings().assistantEndpointId).toBe('contour-company-dev');
  });

  it('управляемый профиль появляется в общем списке эндпоинтов', () => {
    applyContour(deps(), PLATFORM, { targets: ['assistant'], model: 'gpt-4o' });
    const profile = store
      .getSettings()
      .endpointProfiles.find((item) => item.id === 'contour-company-dev');
    expect(profile).toMatchObject({
      baseUrl: 'http://127.0.0.1:5179/company-dev/v1',
      model: 'gpt-4o',
      ownerPlatformId: 'company-dev',
      writeToken: false,
    });
  });

  it('пустая модель в запросе профиль без модели не оставляет', () => {
    // Ревью Т6 (M5): пустая строка читалась как выбор «пусть решает CLI», и
    // профиль оставался без модели НАВСЕГДА — а план на том же состоянии
    // продолжал обещать модель каталога. Профиль без модели отправляет CLI в
    // контур с именем вендора, то есть в 403 на первом сообщении.
    store.savePlatformHealth(PLATFORM.id, {
      outcome: 'ok',
      reachable: true,
      url: '',
      detail: '',
      models: [{ id: 'company-mid' }],
      capabilities: [],
      limits: {},
      notes: [],
      compromises: [],
      checkedAt: '2026-09-12T10:00:00.000Z',
    });
    applyContour(deps(), PLATFORM, { targets: ['assistant'], model: '' });
    const profile = store
      .getSettings()
      .endpointProfiles.find((item) => item.id === 'contour-company-dev');
    expect(profile?.model).toBe('company-mid');
  });

  it('прежний выбор ассистента запоминается — откату будет куда вернуться', () => {
    store.updateSettings({ assistantEndpointId: 'ep-1' });
    // Занятое место у ассистента — это его собственный выбор профиля, и без
    // явного согласия контур его не перебивает.
    applyContour(deps(), PLATFORM, { targets: ['assistant'], overwrite: ['assistant'] });
    expect(store.getPlatformApplied()['company-dev']?.previousAssistantProfileId).toBe('ep-1');
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
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:5179/company-dev',
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

  /**
   * Аудит DRV-21. Ответ и проверка занятого места строились по плану с моделью
   * ПО УМОЛЧАНИЮ, а в файл уходила присланная: человек видел в ответе одно,
   * в файле лежало другое, и ключ, уже стоящий ровно в нужное значение,
   * читался как чужой.
   */
  it('ответ говорит о записанной модели, а не о модели по умолчанию', () => {
    const platform = { ...PLATFORM, defaultModel: 'default-model' };
    writePlatform(store, platform);
    const result = applyContour(deps(), platform, { targets: ['claude'], model: 'picked-model' });

    const written = result.applied[0]?.written.find((item) => item.key === 'ANTHROPIC_MODEL');
    expect(written?.value).toBe('picked-model');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      env: Record<string, string>;
    };
    expect(settings.env.ANTHROPIC_MODEL).toBe('picked-model');
  });

  it('ключ, уже стоящий в присланное значение, не считается занятым', () => {
    writeFileSync(settingsPath, JSON.stringify({ env: { ANTHROPIC_MODEL: 'picked-model' } }));
    const platform = { ...PLATFORM, defaultModel: 'default-model' };
    writePlatform(store, platform);

    const result = applyContour(deps(), platform, { targets: ['claude'], model: 'picked-model' });
    expect(result.skipped).toEqual([]);
    expect(result.applied.map((item) => item.targetId)).toEqual(['claude']);
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
    // Своя модель человека в файле — занятое место: без согласия контур её не
    // перебивает (до DRV-21 план без модели этого не видел и перебивал молча).
    applyContour(deps(), PLATFORM, { targets: ['claude'], model: 'gpt-4o', overwrite: ['claude'] });

    const trace = store.getPlatformApplied()['company-dev']?.targets[0];
    expect(trace?.previous).toEqual([
      { key: 'ANTHROPIC_BASE_URL' },
      { key: 'ANTHROPIC_MODEL', value: 'opus' },
      { key: 'ANTHROPIC_AUTH_TOKEN' },
    ]);
    expect(trace?.fingerprint).not.toBe('');
  });

  it('повтор применения не выдаёт наши значения за прежние', () => {
    writeFileSync(settingsPath, JSON.stringify({ env: { ANTHROPIC_MODEL: 'opus' } }));
    applyContour(deps(), PLATFORM, { targets: ['claude'], model: 'gpt-4o', overwrite: ['claude'] });
    applyContour(deps(), PLATFORM, { targets: ['claude'], model: 'gpt-4o' });

    // Иначе откат вернул бы файл в состояние, которое панель сама и сделала, —
    // то есть не вернул бы никуда.
    expect(store.getPlatformApplied()['company-dev']?.targets[0]?.previous).toEqual([
      { key: 'ANTHROPIC_BASE_URL' },
      { key: 'ANTHROPIC_MODEL', value: 'opus' },
      { key: 'ANTHROPIC_AUTH_TOKEN' },
    ]);
  });
});

describe('codex', () => {
  it('целью не предлагается и файла не трогает — ручка шлюзу неизвестна', () => {
    // Живая проба 22.09.2026 (`codex-cli 0.155.1`): конфиг с `wire_api = "chat"`
    // этот CLI не загружает ЦЕЛИКОМ — падает любой его запуск. Пока у шлюза нет
    // `/v1/responses`, записать такую цель значит сломать человеку CLI, поэтому
    // применение до файла не доходит.
    const configPath = join(home, '.codex', 'config.toml');
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(configPath, CODEX_CONFIG);

    const result = applyContour(deps(), PLATFORM, { targets: ['codex'], model: 'gpt-4o' });

    expect(result.applied).toEqual([]);
    expect(readFileSync(configPath, 'utf8')).toBe(CODEX_CONFIG);
    expect(store.getPlatformApplied()['company-dev']).toBeUndefined();
  });

  it('правится только регион model_providers — остальной TOML цел', () => {
    // Писатель проверяется НАПРЯМУЮ: через применение до него сегодня не
    // добраться, а хирургия по чужому TOML — ровно то, что обязано остаться
    // верным к моменту, когда маршрут `/v1/responses` появится.
    const configPath = join(home, '.codex', 'config.toml');
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(configPath, CODEX_CONFIG);

    applyCodexEndpoint(
      configPath,
      'contour-company-dev',
      'http://127.0.0.1:5179/company-dev/v1',
      undefined,
      'responses',
    );
    const text = readFileSync(configPath, 'utf8');

    // Комментарий, чужие таблицы и их содержимое — байт в байт.
    expect(text).toContain('# личные настройки codex');
    expect(text).toContain('[shell_environment_policy.set]\nMY_VAR = "keep-me"');
    expect(text).toContain('[mcp_servers.local]\ncommand = "npx"');
    expect(text).toContain('model = "o3"');
    expect(text).toContain('approval_policy = "on-request"');

    expect(text).toContain('[model_providers.contour-company-dev]');
    expect(text).toContain('base_url = "http://127.0.0.1:5179/company-dev/v1"');
    // Ручка — та, которую принимает сам CLI; `chat` и был тем, что его ломало.
    expect(text).toContain('wire_api = "responses"');
    // Корневой выбор провайдера — иначе запись мертва.
    expect(text).toContain('model_provider = "contour-company-dev"');
  });

  it('прежний выбор провайдера уезжает в след', () => {
    const configPath = join(home, '.codex', 'config.toml');
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(configPath, 'model_provider = "openai"\n');

    // Уже выбранный провайдер — занятое место: в след уходит прежнее имя, иначе
    // откат вернул бы человеку не его настройку.
    const result = applyCodexEndpoint(
      configPath,
      'contour-company-dev',
      'http://127.0.0.1:5179/company-dev/v1',
      undefined,
      'responses',
    );
    expect(result.previous).toEqual([{ key: 'model_provider', value: 'openai' }]);
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
    expect(store.getPlatformApplied()['company-dev']).toBeUndefined();
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
    ).toBe('http://127.0.0.1:5179/company-dev');
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
    ).toBe('http://127.0.0.1:5180/company-dev');
    expect(
      store.getSettings().endpointProfiles.find((item) => item.id === 'contour-company-dev')
        ?.baseUrl,
    ).toBe('http://127.0.0.1:5180/company-dev/v1');
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

    // Codex из перебора ушёл не по недосмотру: его ручку шлюз не обслуживает,
    // и целью он сегодня не предлагается вовсе (`targets.ts`).
    const targets = ['assistant', 'claude', 'qwen', 'aider', 'continue'];
    const result = applyContour(deps(), PLATFORM, { targets, model: 'gpt-4o' });
    expect(result.applied.map((item) => item.targetId)).toEqual(targets);

    const files = [...walk(home), ...walk(join(root, 'claude')), ...walk(backupDir)];
    // По файлу на каждую ПИШУЩУЮ цель: ассистент живёт в настройках панели и
    // файла не трогает, остальные четыре — трогают. Меньше — значит перебор
    // прошёл мимо чьего-то файла, и «ключа нигде нет» доказано не было.
    expect(files.length).toBeGreaterThanOrEqual(targets.length - 1);
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
