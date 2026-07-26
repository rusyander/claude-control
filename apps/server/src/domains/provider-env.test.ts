import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseToml } from 'smol-toml';
import type { ProviderEnvVar } from '@claude-control/contracts';
import { getProvider } from '../providers/registry.ts';
import {
  resolveProviderEnvTarget,
  readProviderEnvVars,
  saveProviderEnvVars,
  parseProviderEnvDraft,
  UnrecognizedFormatError,
  EnvKeyPreservedError,
  type ProviderEnvTarget,
} from './provider-env.ts';

/** Фейковое хранилище настроек. */
function fakeStore(provider: string, claudeDirOverride = '') {
  return { getSettings: () => ({ provider, claudeDirOverride }) };
}

/** Разобранный config.toml для проверок. */
interface ParsedToml {
  model?: string;
  approval_policy?: string;
  mcp_servers?: Record<string, Record<string, unknown>>;
  shell_environment_policy?: Record<string, unknown>;
}
const asToml = (text: string): ParsedToml => parseToml(text) as unknown as ParsedToml;

describe('resolveProviderEnvTarget: fail-closed по провайдеру', () => {
  it('codex → toml-цель (config.toml)', () => {
    const target = resolveProviderEnvTarget(fakeStore('codex'));
    expect(target).toMatchObject({ format: 'toml' });
    expect(target?.filePath.endsWith('config.toml')).toBe(true);
  });

  it('claude → undefined (у него свои роуты /api/env)', () => {
    expect(resolveProviderEnvTarget(fakeStore('claude'))).toBeUndefined();
  });

  it('gemini → dotenv-цель (~/.gemini/.env)', () => {
    const target = resolveProviderEnvTarget(fakeStore('gemini'));
    expect(target).toMatchObject({ format: 'dotenv' });
    expect(target?.filePath.endsWith('.env')).toBe(true);
  });

  // OPENCODE-2: у opencode env объявлен `unsupported` (хранить переменные негде),
  // поэтому цель не резолвится — раздел скрыт, а не «в разработке».
  it('cursor/opencode → undefined', () => {
    for (const id of ['cursor', 'opencode'] as const) {
      expect(resolveProviderEnvTarget(fakeStore(id))).toBeUndefined();
    }
  });

  it('aider → yaml-цель (~/.aider.conf.yml, задокументированный ключ set-env)', () => {
    const target = resolveProviderEnvTarget(fakeStore('aider'));
    expect(target).toMatchObject({ format: 'aider-yaml' });
    expect(target?.filePath.endsWith('.aider.conf.yml')).toBe(true);
  });

  it('незнакомый провайдер откатывается на claude → undefined', () => {
    expect(resolveProviderEnvTarget(fakeStore('nonexistent'))).toBeUndefined();
  });
});

describe('parseProviderEnvDraft: валидация набора', () => {
  it('корректный набор разбирается', () => {
    expect(parseProviderEnvDraft({ vars: [{ key: ' CI ', value: '1' }] })).toEqual([
      { key: 'CI', value: '1' },
    ]);
  });
  it('пустое имя → отклоняется', () => {
    expect(parseProviderEnvDraft({ vars: [{ key: '  ', value: '1' }] })).toBeUndefined();
  });
  it('значение не строка → отклоняется', () => {
    expect(parseProviderEnvDraft({ vars: [{ key: 'X', value: 5 }] })).toBeUndefined();
  });
  it('не массив vars → отклоняется', () => {
    expect(parseProviderEnvDraft({})).toBeUndefined();
    expect(parseProviderEnvDraft(null)).toBeUndefined();
  });
  it('пустой набор допустим (стирает все переменные)', () => {
    expect(parseProviderEnvDraft({ vars: [] })).toEqual([]);
  });
  it('дубликаты ключей схлопываются, последний побеждает', () => {
    expect(
      parseProviderEnvDraft({
        vars: [
          { key: 'A', value: '1' },
          { key: 'A', value: '2' },
        ],
      }),
    ).toEqual([{ key: 'A', value: '2' }]);
  });
});

describe('Codex TOML env: хирургическая запись shell_environment_policy.set', () => {
  let root: string;
  let backupDir: string;

  const targetFor = (filePath: string): ProviderEnvTarget => ({
    provider: getProvider('codex'),
    format: 'toml',
    filePath,
    cliDetected: false,
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-codex-env-'));
    backupDir = join(root, 'backups');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  // Файл с моделью, аппрувом, mcp_servers, комментариями и уже существующей
  // политикой окружения (inherit + exclude + set) — всё это должно уцелеть.
  const CONFIG = `# Codex config
model = "gpt-5"
approval_policy = "on-request"

[shell_environment_policy]
inherit = "all"
exclude = ["AWS_*"]
ignore_default_excludes = false
set = { CI = "1", NO_COLOR = "1" }

# существующий MCP-сервер
[mcp_servers.existing]
command = "node"
args = ["server.js"]
`;

  it('чтение возвращает пары из set', () => {
    const filePath = join(root, 'config.toml');
    writeFileSync(filePath, CONFIG, 'utf8');
    expect(readProviderEnvVars(targetFor(filePath))).toEqual([
      { key: 'CI', value: '1' },
      { key: 'NO_COLOR', value: '1' },
    ]);
  });

  it('добавление переменной: политика (inherit/exclude), mcp_servers и комментарии целы', () => {
    const filePath = join(root, 'config.toml');
    writeFileSync(filePath, CONFIG, 'utf8');

    const next: ProviderEnvVar[] = [
      { key: 'CI', value: '1' },
      { key: 'NO_COLOR', value: '1' },
      { key: 'ADDED', value: 'yes' },
    ];
    saveProviderEnvVars(targetFor(filePath), next, backupDir);
    const text = readFileSync(filePath, 'utf8');

    // Вне региона политики — байт-в-байт: модель, аппрув, комментарии, mcp_servers.
    expect(text).toContain('# Codex config');
    expect(text).toContain('model = "gpt-5"');
    expect(text).toContain('approval_policy = "on-request"');
    expect(text).toContain('# существующий MCP-сервер');

    const parsed = asToml(text);
    // Прочие ключи политики окружения сохранены ПО ЗНАЧЕНИЯМ.
    expect(parsed.shell_environment_policy?.inherit).toBe('all');
    expect(parsed.shell_environment_policy?.exclude).toEqual(['AWS_*']);
    expect(parsed.shell_environment_policy?.ignore_default_excludes).toBe(false);
    // set — новое намерение.
    expect(parsed.shell_environment_policy?.set).toEqual({ CI: '1', NO_COLOR: '1', ADDED: 'yes' });
    // Чужой mcp-сервер цел.
    expect(parsed.mcp_servers?.existing).toEqual({ command: 'node', args: ['server.js'] });
  });

  it('изменение значения переменной: inherit цел, значение обновлено', () => {
    const filePath = join(root, 'config.toml');
    writeFileSync(filePath, CONFIG, 'utf8');
    saveProviderEnvVars(
      targetFor(filePath),
      [
        { key: 'CI', value: 'false' },
        { key: 'NO_COLOR', value: '1' },
      ],
      backupDir,
    );
    const parsed = asToml(readFileSync(filePath, 'utf8'));
    expect(parsed.shell_environment_policy?.inherit).toBe('all');
    expect(parsed.shell_environment_policy?.set).toEqual({ CI: 'false', NO_COLOR: '1' });
  });

  it('удаление переменной: остальные и inherit целы', () => {
    const filePath = join(root, 'config.toml');
    writeFileSync(filePath, CONFIG, 'utf8');
    saveProviderEnvVars(targetFor(filePath), [{ key: 'CI', value: '1' }], backupDir);
    const parsed = asToml(readFileSync(filePath, 'utf8'));
    expect(parsed.shell_environment_policy?.inherit).toBe('all');
    expect(parsed.shell_environment_policy?.set).toEqual({ CI: '1' });
  });

  it('пустой набор: set становится пустым, политика цела, файл репарсится', () => {
    const filePath = join(root, 'config.toml');
    writeFileSync(filePath, CONFIG, 'utf8');
    saveProviderEnvVars(targetFor(filePath), [], backupDir);
    const parsed = asToml(readFileSync(filePath, 'utf8'));
    expect(parsed.shell_environment_policy?.inherit).toBe('all');
    expect(parsed.shell_environment_policy?.set).toEqual({});
    expect(readProviderEnvVars(targetFor(filePath))).toEqual([]);
  });

  it('нет файла → создаётся только с shell_environment_policy.set', () => {
    const filePath = join(root, '.codex', 'config.toml');
    saveProviderEnvVars(targetFor(filePath), [{ key: 'ONLY', value: '1' }], backupDir);
    expect(existsSync(filePath)).toBe(true);
    const parsed = asToml(readFileSync(filePath, 'utf8'));
    expect(Object.keys(parsed)).toEqual(['shell_environment_policy']);
    expect(parsed.shell_environment_policy?.set).toEqual({ ONLY: '1' });
  });

  it('нет секции политики в существующем файле → добавляется, model цел', () => {
    const filePath = join(root, 'config.toml');
    writeFileSync(filePath, 'model = "gpt-5"\n[mcp_servers.x]\ncommand = "node"\n', 'utf8');
    saveProviderEnvVars(targetFor(filePath), [{ key: 'A', value: '1' }], backupDir);
    const text = readFileSync(filePath, 'utf8');
    expect(text).toContain('model = "gpt-5"');
    const parsed = asToml(text);
    expect(parsed.shell_environment_policy?.set).toEqual({ A: '1' });
    expect(parsed.mcp_servers?.x).toEqual({ command: 'node' });
  });

  it('round-trip read→write→read стабилен', () => {
    const filePath = join(root, 'config.toml');
    writeFileSync(filePath, CONFIG, 'utf8');
    const before = readProviderEnvVars(targetFor(filePath));
    saveProviderEnvVars(targetFor(filePath), before, backupDir);
    const after = readProviderEnvVars(targetFor(filePath));
    expect(after).toEqual(before);
  });

  // set с нестроковыми значениями: TOML это позволяет (PORT = 8080), панель их
  // не показывает — и потому не должна терять на обычном «Сохранить».
  const CONFIG_MIXED = `[shell_environment_policy]
inherit = "all"

[shell_environment_policy.set]
CI = "1"
PORT = 8080
DEBUG = true
`;

  it('нестроковые значения set не показываются, но переживают запись', () => {
    const filePath = join(root, 'config.toml');
    writeFileSync(filePath, CONFIG_MIXED, 'utf8');

    // Панель ведёт только строки.
    expect(readProviderEnvVars(targetFor(filePath))).toEqual([{ key: 'CI', value: '1' }]);

    // «Сохранить» без правок: PORT и DEBUG обязаны остаться в чужом конфиге.
    saveProviderEnvVars(targetFor(filePath), [{ key: 'CI', value: '1' }], backupDir);
    const parsed = asToml(readFileSync(filePath, 'utf8'));
    expect(parsed.shell_environment_policy?.set).toEqual({ CI: '1', PORT: 8080, DEBUG: true });
    expect(parsed.shell_environment_policy?.inherit).toBe('all');

    // Правка строковой переменной их тоже не задевает.
    saveProviderEnvVars(
      targetFor(filePath),
      [
        { key: 'CI', value: 'false' },
        { key: 'NEW', value: 'x' },
      ],
      backupDir,
    );
    expect(asToml(readFileSync(filePath, 'utf8')).shell_environment_policy?.set).toEqual({
      CI: 'false',
      NEW: 'x',
      PORT: 8080,
      DEBUG: true,
    });
  });

  it('удаление строковой переменной не трогает нестроковые', () => {
    const filePath = join(root, 'config.toml');
    writeFileSync(filePath, CONFIG_MIXED, 'utf8');
    saveProviderEnvVars(targetFor(filePath), [], backupDir);
    expect(asToml(readFileSync(filePath, 'utf8')).shell_environment_policy?.set).toEqual({
      PORT: 8080,
      DEBUG: true,
    });
  });

  it('черновик, назвавший нестроковый ключ, → именной отказ, а не «формат не распознан»', () => {
    // Отказ про ОДНО имя: файл разобран, раздел остаётся на запись. Пока этот
    // случай шёл общей ошибкой формата, пользователю сообщали, что его
    // config.toml нечитаем и доступен только на чтение, — неправда, и без
    // единого слова о том, какая переменная мешает.
    const filePath = join(root, 'config.toml');
    writeFileSync(filePath, CONFIG_MIXED, 'utf8');

    const call = () =>
      saveProviderEnvVars(
        targetFor(filePath),
        [
          { key: 'CI', value: '1' },
          { key: 'PORT', value: '9090' },
        ],
        backupDir,
      );

    expect(call).toThrow(EnvKeyPreservedError);
    expect(call).not.toThrow(UnrecognizedFormatError);
    expect(call).toThrow(/PORT/);
    expect(readFileSync(filePath, 'utf8')).toBe(CONFIG_MIXED);
  });

  it('повторная запись создаёт резервную копию', () => {
    const filePath = join(root, 'config.toml');
    writeFileSync(filePath, CONFIG, 'utf8');
    saveProviderEnvVars(targetFor(filePath), [{ key: 'A', value: '1' }], backupDir);
    saveProviderEnvVars(targetFor(filePath), [{ key: 'B', value: '2' }], backupDir);
    const backups = readdirSync(backupDir).filter((n) => n.endsWith('.bak'));
    expect(backups.length).toBeGreaterThanOrEqual(1);
  });

  it('непарсящийся TOML → отказ записи (fail-closed), файл не тронут', () => {
    const filePath = join(root, 'config.toml');
    const broken = 'model = "gpt-5\n[shell_environment_policy\nset =';
    writeFileSync(filePath, broken, 'utf8');
    expect(() =>
      saveProviderEnvVars(targetFor(filePath), [{ key: 'A', value: '1' }], backupDir),
    ).toThrow(UnrecognizedFormatError);
    expect(readFileSync(filePath, 'utf8')).toBe(broken);
  });

  it('непарсящийся TOML → чтение тоже бросает (раздел только для чтения)', () => {
    const filePath = join(root, 'config.toml');
    writeFileSync(filePath, '[shell_environment_policy\nset =', 'utf8');
    expect(() => readProviderEnvVars(targetFor(filePath))).toThrow(UnrecognizedFormatError);
  });

  it('разорванный регион политики → отказ записи (fail-closed)', () => {
    const filePath = join(root, 'config.toml');
    // Таблицы shell_environment_policy разорваны секцией [mcp_servers.x].
    const split = `[shell_environment_policy]
inherit = "all"

[mcp_servers.x]
command = "node"

[shell_environment_policy.set]
CI = "1"
`;
    writeFileSync(filePath, split, 'utf8');
    expect(() =>
      saveProviderEnvVars(targetFor(filePath), [{ key: 'A', value: '1' }], backupDir),
    ).toThrow(UnrecognizedFormatError);
    expect(readFileSync(filePath, 'utf8')).toBe(split);
  });

  it('inline/dotted shell_environment_policy на верхнем уровне (нет заголовка) → отказ', () => {
    const filePath = join(root, 'config.toml');
    const inline = 'model = "gpt-5"\nshell_environment_policy = { set = { CI = "1" } }\n';
    writeFileSync(filePath, inline, 'utf8');
    expect(() =>
      saveProviderEnvVars(targetFor(filePath), [{ key: 'A', value: '1' }], backupDir),
    ).toThrow(UnrecognizedFormatError);
    expect(readFileSync(filePath, 'utf8')).toBe(inline);
  });
});

/**
 * GEMINI-3: файл `.env` (глобальный `~/.gemini/.env` и проектный
 * `<проект>/.gemini/.env`). Проверяем то, ради чего адаптер и построчный:
 * комментарии/порядок/чужие строки целы, форма файла (BOM + CRLF) сохранена,
 * перед записью делается копия, нераспознанный файл не перезаписывается.
 */
describe('Gemini .env: построчная правка', () => {
  let root: string;
  let backupDir: string;

  const targetFor = (filePath: string): ProviderEnvTarget => ({
    provider: getProvider('gemini'),
    format: 'dotenv',
    filePath,
    cliDetected: false,
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-gemini-env-'));
    backupDir = join(root, 'backups');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const SAMPLE = `# Ключи Gemini

GEMINI_API_KEY=old
export HTTPS_PROXY="http://127.0.0.1:8080" # прокси
`;

  it('чтение отдаёт пары, отсортированные по имени', () => {
    const filePath = join(root, '.env');
    writeFileSync(filePath, SAMPLE, 'utf8');
    expect(readProviderEnvVars(targetFor(filePath))).toEqual([
      { key: 'GEMINI_API_KEY', value: 'old' },
      { key: 'HTTPS_PROXY', value: 'http://127.0.0.1:8080' },
    ]);
  });

  it('правка одной переменной: комментарии, пустая строка и export-строка целы', () => {
    const filePath = join(root, '.env');
    writeFileSync(filePath, SAMPLE, 'utf8');
    saveProviderEnvVars(
      targetFor(filePath),
      [
        { key: 'GEMINI_API_KEY', value: 'new' },
        { key: 'HTTPS_PROXY', value: 'http://127.0.0.1:8080' },
      ],
      backupDir,
    );
    expect(readFileSync(filePath, 'utf8')).toBe(`# Ключи Gemini

GEMINI_API_KEY=new
export HTTPS_PROXY="http://127.0.0.1:8080" # прокси
`);
    expect(readdirSync(backupDir).some((n) => n.startsWith('gemini-.env.'))).toBe(true);
  });

  it('форма файла сохраняется: BOM и CRLF остаются на месте', () => {
    const filePath = join(root, '.env');
    writeFileSync(filePath, '\ufeff# шапка\r\nA=1\r\n', 'utf8');
    saveProviderEnvVars(targetFor(filePath), [{ key: 'A', value: '2' }], backupDir);
    expect(readFileSync(filePath, 'utf8')).toBe('\ufeff# шапка\r\nA=2\r\n');
  });

  it('нет файла → создаётся только с заданными переменными', () => {
    const filePath = join(root, 'nested', '.env');
    saveProviderEnvVars(targetFor(filePath), [{ key: 'A', value: '1' }], backupDir);
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, 'utf8')).toBe('A=1\n');
  });

  it('нераспознанный файл → отказ записи, содержимое не тронуто (fail-closed)', () => {
    const filePath = join(root, '.env');
    const broken = 'A=1\nэто не присваивание\n';
    writeFileSync(filePath, broken, 'utf8');
    expect(() =>
      saveProviderEnvVars(targetFor(filePath), [{ key: 'A', value: '2' }], backupDir),
    ).toThrow(UnrecognizedFormatError);
    expect(readFileSync(filePath, 'utf8')).toBe(broken);
  });

  it('round-trip read→write→read стабилен', () => {
    const filePath = join(root, '.env');
    writeFileSync(filePath, SAMPLE, 'utf8');
    const before = readProviderEnvVars(targetFor(filePath));
    saveProviderEnvVars(targetFor(filePath), before, backupDir);
    expect(readProviderEnvVars(targetFor(filePath))).toEqual(before);
    expect(readFileSync(filePath, 'utf8')).toBe(SAMPLE);
  });
});
