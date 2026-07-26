import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { parse as parseToml } from 'smol-toml';
import { getProvider } from '../providers/registry.ts';
import {
  resolveProviderMcpTarget,
  readProviderMcpServers,
  upsertProviderMcpServer,
  deleteProviderMcpServer,
  parseUniversalDraft,
  UnrecognizedFormatError,
  McpServerExistsError,
  type ProviderMcpTarget,
} from './provider-mcp.ts';

/** Фейковое хранилище настроек. */
function fakeStore(provider: string, claudeDirOverride = '') {
  return { getSettings: () => ({ provider, claudeDirOverride }) };
}

/** Разобранный config.toml с секцией mcp_servers — для проверок в тестах. */
interface ParsedToml {
  mcp_servers: Record<string, Record<string, unknown>>;
  tools?: Record<string, unknown>;
}
const asToml = (text: string): ParsedToml => parseToml(text) as unknown as ParsedToml;

describe('resolveProviderMcpTarget: fail-closed по провайдеру', () => {
  it('codex → toml-цель, gemini/cursor → json-цель, opencode → opencode-json', () => {
    expect(resolveProviderMcpTarget(fakeStore('codex'))).toMatchObject({ format: 'toml' });
    expect(resolveProviderMcpTarget(fakeStore('gemini'))).toMatchObject({
      format: 'json',
      jsonHttpUrlKey: 'httpUrl',
    });
    // Ф8: Cursor — тот же JSON-адаптер (ключ mcpServers), но адрес http в `url`.
    expect(resolveProviderMcpTarget(fakeStore('cursor'))).toMatchObject({
      format: 'json',
      jsonHttpUrlKey: 'url',
      filePath: join(homedir(), '.cursor', 'mcp.json'),
    });
    expect(resolveProviderMcpTarget(fakeStore('opencode'))).toMatchObject({
      format: 'opencode-json',
      filePath: join(homedir(), '.config', 'opencode', 'opencode.json'),
    });
  });

  it('claude → undefined (у него свои роуты /api/mcp)', () => {
    expect(resolveProviderMcpTarget(fakeStore('claude'))).toBeUndefined();
  });

  it('провайдер без mcp=ready (aider) → undefined', () => {
    expect(resolveProviderMcpTarget(fakeStore('aider'))).toBeUndefined();
  });

  it('незнакомый провайдер откатывается на claude → undefined', () => {
    expect(resolveProviderMcpTarget(fakeStore('nonexistent'))).toBeUndefined();
  });
});

describe('parseUniversalDraft: валидация черновика', () => {
  it('stdio без команды отклоняется', () => {
    expect(parseUniversalDraft({ name: 'x', transport: 'stdio' })).toBeUndefined();
  });
  it('http без адреса отклоняется', () => {
    expect(parseUniversalDraft({ name: 'x', transport: 'http' })).toBeUndefined();
  });
  it('без имени/транспорта отклоняется', () => {
    expect(parseUniversalDraft({ transport: 'stdio', command: 'x' })).toBeUndefined();
    expect(parseUniversalDraft({ name: 'x', command: 'y' })).toBeUndefined();
  });
  it('корректный stdio разбирается, мусорный env/args отсекается', () => {
    const draft = parseUniversalDraft({
      name: ' srv ',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 123, 'pkg'],
      env: { A: 'b', C: 5 },
    });
    expect(draft).toEqual({
      name: 'srv',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'pkg'],
      env: {},
      url: undefined,
      headers: {},
    });
  });
});

describe('Codex TOML: хирургическая запись сохраняет чужой конфиг', () => {
  let root: string;
  let backupDir: string;
  const stdioDraft = (name: string, command: string) => ({
    name,
    transport: 'stdio' as const,
    command,
    args: ['-y', 'pkg'],
    env: { TOKEN: 'abc' },
    url: undefined,
    headers: {},
  });

  const targetFor = (filePath: string): ProviderMcpTarget => ({
    provider: getProvider('codex'),
    format: 'toml',
    filePath,
    cliDetected: false,
    jsonHttpUrlKey: 'httpUrl',
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-codex-mcp-'));
    backupDir = join(root, 'backups');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const CONFIG = `# Codex config
model = "gpt-5"
approval_policy = "on-request"

# существующий MCP-сервер
[mcp_servers.existing]
command = "node"
args = ["server.js"]
startup_timeout_sec = 20

[mcp_servers.existing.env]
KEY = "value"

[tools]
web_search = true
`;

  /** Пара задокументированных полей codex, которыми панель не управляет. */
  const TIMEOUTS = 'startup_timeout_sec = 20\ntool_timeout_sec = 60';

  it('добавление сервера: прочие ключи, комментарии и чужой сервер целы; оба сервера на месте', () => {
    const filePath = join(root, 'config.toml');
    writeFileSync(filePath, CONFIG, 'utf8');

    upsertProviderMcpServer(targetFor(filePath), null, stdioDraft('added', 'npx'), backupDir);
    const text = readFileSync(filePath, 'utf8');

    // Ключи и комментарии вне mcp_servers сохранены байт-в-байт.
    expect(text).toContain('# Codex config');
    expect(text).toContain('model = "gpt-5"');
    expect(text).toContain('approval_policy = "on-request"');
    expect(text).toContain('[tools]');
    expect(text).toContain('web_search = true');

    // Файл валидно репарсится, оба сервера на месте, чужие поля существующего целы.
    const parsed = asToml(text);
    expect(Object.keys(parsed.mcp_servers).sort()).toEqual(['added', 'existing']);
    expect(parsed.mcp_servers.existing!.startup_timeout_sec).toBe(20);
    expect(parsed.mcp_servers.existing!.env).toEqual({ KEY: 'value' });
    expect(parsed.mcp_servers.added).toMatchObject({ command: 'npx', args: ['-y', 'pkg'] });
    expect(parsed.tools).toEqual({ web_search: true });
  });

  it('чтение возвращает универсальный субсет', () => {
    const filePath = join(root, 'config.toml');
    writeFileSync(filePath, CONFIG, 'utf8');
    const servers = readProviderMcpServers(targetFor(filePath));
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({
      name: 'existing',
      transport: 'stdio',
      command: 'node',
      env: { KEY: 'value' },
    });
  });

  it('правка сервера: немоделируемые поля самой записи переживают перезапись', () => {
    const filePath = join(root, 'config.toml');
    writeFileSync(filePath, CONFIG.replace('startup_timeout_sec = 20', TIMEOUTS), 'utf8');

    upsertProviderMcpServer(
      targetFor(filePath),
      'existing',
      stdioDraft('existing', 'deno'),
      backupDir,
    );

    const parsed = asToml(readFileSync(filePath, 'utf8'));
    // Панель владеет только command/args/env — таймауты codex не её поля.
    expect(parsed.mcp_servers.existing).toEqual({
      startup_timeout_sec: 20,
      tool_timeout_sec: 60,
      command: 'deno',
      args: ['-y', 'pkg'],
      env: { TOKEN: 'abc' },
    });
  });

  it('переименование: чужие поля переезжают со старого имени, старой таблицы нет', () => {
    const filePath = join(root, 'config.toml');
    writeFileSync(filePath, CONFIG, 'utf8');

    upsertProviderMcpServer(
      targetFor(filePath),
      'existing',
      stdioDraft('renamed', 'deno'),
      backupDir,
    );

    const parsed = asToml(readFileSync(filePath, 'utf8'));
    expect(Object.keys(parsed.mcp_servers)).toEqual(['renamed']);
    expect(parsed.mcp_servers.renamed!.startup_timeout_sec).toBe(20);
  });

  it('смена транспорта на http: моделируемые stdio-ключи уходят, чужие остаются', () => {
    const filePath = join(root, 'config.toml');
    writeFileSync(filePath, CONFIG, 'utf8');

    upsertProviderMcpServer(
      targetFor(filePath),
      'existing',
      {
        name: 'existing',
        transport: 'http',
        command: undefined,
        args: [],
        env: {},
        url: 'https://example.com/mcp',
        headers: {},
      },
      backupDir,
    );

    const parsed = asToml(readFileSync(filePath, 'utf8'));
    expect(parsed.mcp_servers.existing).toEqual({
      startup_timeout_sec: 20,
      url: 'https://example.com/mcp',
    });
  });

  it('удаление сервера: остальное цело, файл репарсится', () => {
    const filePath = join(root, 'config.toml');
    writeFileSync(filePath, CONFIG, 'utf8');
    // Сначала добавим второй, затем удалим первый.
    upsertProviderMcpServer(targetFor(filePath), null, stdioDraft('added', 'npx'), backupDir);
    deleteProviderMcpServer(targetFor(filePath), 'existing', backupDir);

    const text = readFileSync(filePath, 'utf8');
    expect(text).toContain('model = "gpt-5"');
    expect(text).toContain('[tools]');
    const parsed = asToml(text);
    expect(Object.keys(parsed.mcp_servers)).toEqual(['added']);
  });

  it('http-сервер пишется через url + http_headers (без transport-ключа, без env)', () => {
    const filePath = join(root, 'config.toml');
    writeFileSync(filePath, 'model = "gpt-5"\n', 'utf8');
    upsertProviderMcpServer(
      targetFor(filePath),
      null,
      {
        name: 'remote',
        transport: 'http',
        command: undefined,
        args: [],
        env: {},
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer x' },
      },
      backupDir,
    );
    const parsed = asToml(readFileSync(filePath, 'utf8'));
    expect(parsed.mcp_servers.remote).toEqual({
      url: 'https://example.com/mcp',
      http_headers: { Authorization: 'Bearer x' },
    });
    expect(parsed.mcp_servers.remote!.transport).toBeUndefined();
  });

  it('нет файла → создаётся только с mcp_servers', () => {
    const filePath = join(root, '.codex', 'config.toml');
    upsertProviderMcpServer(targetFor(filePath), null, stdioDraft('only', 'npx'), backupDir);
    expect(existsSync(filePath)).toBe(true);
    const parsed = asToml(readFileSync(filePath, 'utf8'));
    expect(Object.keys(parsed)).toEqual(['mcp_servers']);
    expect(Object.keys(parsed.mcp_servers)).toEqual(['only']);
  });

  it('повторная запись создаёт резервную копию', () => {
    const filePath = join(root, 'config.toml');
    writeFileSync(filePath, CONFIG, 'utf8');
    upsertProviderMcpServer(targetFor(filePath), null, stdioDraft('a', 'npx'), backupDir);
    upsertProviderMcpServer(targetFor(filePath), null, stdioDraft('b', 'npx'), backupDir);
    const backups = readdirSync(backupDir).filter((n) => n.endsWith('.bak'));
    expect(backups.length).toBeGreaterThanOrEqual(1);
  });

  it('непарсящийся TOML → отказ записи (fail-closed), файл не тронут', () => {
    const filePath = join(root, 'config.toml');
    const broken = 'model = "gpt-5\n[mcp_servers.x\ncommand =';
    writeFileSync(filePath, broken, 'utf8');

    expect(() =>
      upsertProviderMcpServer(targetFor(filePath), null, stdioDraft('a', 'npx'), backupDir),
    ).toThrow(UnrecognizedFormatError);
    expect(readFileSync(filePath, 'utf8')).toBe(broken);
  });

  it('непарсящийся TOML → чтение тоже бросает (раздел только для чтения)', () => {
    const filePath = join(root, 'config.toml');
    writeFileSync(filePath, '[mcp_servers.x\ncommand =', 'utf8');
    expect(() => readProviderMcpServers(targetFor(filePath))).toThrow(UnrecognizedFormatError);
  });

  it('неоднозначный (непрерывный) регион mcp_servers → отказ записи', () => {
    const filePath = join(root, 'config.toml');
    // Таблицы mcp_servers разорваны секцией [tools] — регион неоднозначен.
    const split = `[mcp_servers.a]
command = "a"

[tools]
x = 1

[mcp_servers.b]
command = "b"
`;
    writeFileSync(filePath, split, 'utf8');
    expect(() =>
      upsertProviderMcpServer(targetFor(filePath), null, stdioDraft('c', 'npx'), backupDir),
    ).toThrow(UnrecognizedFormatError);
    expect(readFileSync(filePath, 'utf8')).toBe(split);
  });
});

describe('Gemini JSON: правим только mcpServers, прочее цело', () => {
  let root: string;
  let backupDir: string;
  const targetFor = (filePath: string): ProviderMcpTarget => ({
    provider: getProvider('gemini'),
    format: 'json',
    filePath,
    cliDetected: false,
    jsonHttpUrlKey: 'httpUrl',
  });
  const stdioDraft = (name: string) => ({
    name,
    transport: 'stdio' as const,
    command: 'npx',
    args: ['-y', 'pkg'],
    env: { TOKEN: 'abc' },
    url: undefined,
    headers: {},
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-gemini-mcp-'));
    backupDir = join(root, 'backups');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const SETTINGS = {
    theme: 'Dracula',
    selectedAuthType: 'oauth-personal',
    mcpServers: {
      existing: { command: 'node', args: ['s.js'], trust: true },
    },
  };

  it('добавление сервера: прочие ключи и чужой сервер (с полем trust) сохранены', () => {
    const filePath = join(root, 'settings.json');
    writeFileSync(filePath, JSON.stringify(SETTINGS, null, 2), 'utf8');

    upsertProviderMcpServer(targetFor(filePath), null, stdioDraft('added'), backupDir);
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));

    expect(parsed.theme).toBe('Dracula');
    expect(parsed.selectedAuthType).toBe('oauth-personal');
    expect(Object.keys(parsed.mcpServers).sort()).toEqual(['added', 'existing']);
    expect(parsed.mcpServers.existing).toEqual({ command: 'node', args: ['s.js'], trust: true });
    expect(parsed.mcpServers.added).toMatchObject({ command: 'npx', env: { TOKEN: 'abc' } });
  });

  it('http-сервер пишется через httpUrl + headers; читается как транспорт http', () => {
    const filePath = join(root, 'settings.json');
    upsertProviderMcpServer(
      targetFor(filePath),
      null,
      {
        name: 'remote',
        transport: 'http',
        command: undefined,
        args: [],
        env: {},
        url: 'https://e/mcp',
        headers: { Authorization: 'Bearer x' },
      },
      backupDir,
    );
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(parsed.mcpServers.remote).toEqual({
      httpUrl: 'https://e/mcp',
      headers: { Authorization: 'Bearer x' },
    });

    const servers = readProviderMcpServers(targetFor(filePath));
    expect(servers[0]).toMatchObject({ name: 'remote', transport: 'http', url: 'https://e/mcp' });
  });

  it('round-trip read→write→read стабилен', () => {
    const filePath = join(root, 'settings.json');
    writeFileSync(filePath, JSON.stringify(SETTINGS, null, 2), 'utf8');
    const before = readProviderMcpServers(targetFor(filePath));
    // Перезапишем существующий его же данными.
    for (const s of before) {
      upsertProviderMcpServer(targetFor(filePath), s.name, { ...s, command: s.command }, backupDir);
    }
    const after = readProviderMcpServers(targetFor(filePath));
    expect(after.map((s) => s.name)).toEqual(before.map((s) => s.name));
  });

  it('удаление сервера: прочие ключи целы', () => {
    const filePath = join(root, 'settings.json');
    writeFileSync(filePath, JSON.stringify(SETTINGS, null, 2), 'utf8');
    deleteProviderMcpServer(targetFor(filePath), 'existing', backupDir);
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(parsed.theme).toBe('Dracula');
    expect(parsed.mcpServers).toEqual({});
  });

  it('нет файла → создаётся только с mcpServers', () => {
    const filePath = join(root, '.gemini', 'settings.json');
    upsertProviderMcpServer(targetFor(filePath), null, stdioDraft('only'), backupDir);
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(Object.keys(parsed)).toEqual(['mcpServers']);
  });

  it('невалидный JSON → отказ записи (fail-closed), файл не тронут', () => {
    const filePath = join(root, 'settings.json');
    const broken = '{ "theme": "x", ';
    writeFileSync(filePath, broken, 'utf8');
    expect(() =>
      upsertProviderMcpServer(targetFor(filePath), null, stdioDraft('a'), backupDir),
    ).toThrow(UnrecognizedFormatError);
    expect(readFileSync(filePath, 'utf8')).toBe(broken);
  });
});

describe('Cursor JSON (~/.cursor/mcp.json): тот же адаптер mcpServers, адрес в url', () => {
  let root: string;
  let backupDir: string;
  const targetFor = (filePath: string): ProviderMcpTarget => ({
    provider: getProvider('cursor'),
    format: 'json',
    filePath,
    cliDetected: false,
    jsonHttpUrlKey: 'url',
  });
  const stdioDraft = (name: string) => ({
    name,
    transport: 'stdio' as const,
    command: 'npx',
    args: ['-y', 'pkg'],
    env: { TOKEN: 'abc' },
    url: undefined,
    headers: {},
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-cursor-mcp-'));
    backupDir = join(root, 'backups');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const CURSOR_MCP = {
    // Прочие ключи файла (не mcpServers) обязаны сохраняться.
    $schema: 'https://cursor.com/schemas/mcp.json',
    somethingElse: { keep: true },
    mcpServers: {
      existing: { command: 'node', args: ['s.js'], someUnknownField: 42 },
      remote: { url: 'https://remote/mcp', headers: { Authorization: 'Bearer y' } },
    },
  };

  it('чтение: stdio и http (url) распознаны', () => {
    const filePath = join(root, 'mcp.json');
    writeFileSync(filePath, JSON.stringify(CURSOR_MCP, null, 2), 'utf8');
    const servers = readProviderMcpServers(targetFor(filePath));
    expect(servers.map((s) => s.name)).toEqual(['existing', 'remote']);
    expect(servers[0]).toMatchObject({ transport: 'stdio', command: 'node', args: ['s.js'] });
    expect(servers[1]).toMatchObject({
      transport: 'http',
      url: 'https://remote/mcp',
      headers: { Authorization: 'Bearer y' },
    });
  });

  it('добавление: прочие ключи файла и другие серверы целы', () => {
    const filePath = join(root, 'mcp.json');
    writeFileSync(filePath, JSON.stringify(CURSOR_MCP, null, 2), 'utf8');

    upsertProviderMcpServer(targetFor(filePath), null, stdioDraft('added'), backupDir);
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));

    expect(parsed.$schema).toBe('https://cursor.com/schemas/mcp.json');
    expect(parsed.somethingElse).toEqual({ keep: true });
    expect(Object.keys(parsed.mcpServers).sort()).toEqual(['added', 'existing', 'remote']);
    // Чужие серверы (в т.ч. их неизвестные поля) не тронуты.
    expect(parsed.mcpServers.existing).toEqual({
      command: 'node',
      args: ['s.js'],
      someUnknownField: 42,
    });
    expect(parsed.mcpServers.remote).toEqual({
      url: 'https://remote/mcp',
      headers: { Authorization: 'Bearer y' },
    });
    expect(parsed.mcpServers.added).toEqual({
      command: 'npx',
      args: ['-y', 'pkg'],
      env: { TOKEN: 'abc' },
    });
  });

  it('http пишется в url (НЕ httpUrl) и читается обратно', () => {
    const filePath = join(root, 'mcp.json');
    upsertProviderMcpServer(
      targetFor(filePath),
      null,
      {
        name: 'r',
        transport: 'http',
        command: undefined,
        args: [],
        env: {},
        url: 'https://e/mcp',
        headers: { A: 'b' },
      },
      backupDir,
    );
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(parsed.mcpServers.r).toEqual({ url: 'https://e/mcp', headers: { A: 'b' } });
    expect(parsed.mcpServers.r.httpUrl).toBeUndefined();

    const servers = readProviderMcpServers(targetFor(filePath));
    expect(servers[0]).toMatchObject({ transport: 'http', url: 'https://e/mcp' });
  });

  it('нет файла → создаётся только с mcpServers', () => {
    const filePath = join(root, '.cursor', 'mcp.json');
    upsertProviderMcpServer(targetFor(filePath), null, stdioDraft('only'), backupDir);
    expect(existsSync(filePath)).toBe(true);
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(Object.keys(parsed)).toEqual(['mcpServers']);
    expect(Object.keys(parsed.mcpServers)).toEqual(['only']);
  });

  it('удаление сервера: прочие ключи и другой сервер целы', () => {
    const filePath = join(root, 'mcp.json');
    writeFileSync(filePath, JSON.stringify(CURSOR_MCP, null, 2), 'utf8');
    deleteProviderMcpServer(targetFor(filePath), 'existing', backupDir);
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(parsed.$schema).toBe('https://cursor.com/schemas/mcp.json');
    expect(Object.keys(parsed.mcpServers)).toEqual(['remote']);
  });

  it('битый JSON → fail-closed: чтение бросает, запись отказывает, файл не тронут', () => {
    const filePath = join(root, 'mcp.json');
    const broken = '{ "mcpServers": ';
    writeFileSync(filePath, broken, 'utf8');
    expect(() => readProviderMcpServers(targetFor(filePath))).toThrow(UnrecognizedFormatError);
    expect(() =>
      upsertProviderMcpServer(targetFor(filePath), null, stdioDraft('a'), backupDir),
    ).toThrow(UnrecognizedFormatError);
    expect(readFileSync(filePath, 'utf8')).toBe(broken);
  });

  it('round-trip read→write→read стабилен', () => {
    const filePath = join(root, 'mcp.json');
    writeFileSync(filePath, JSON.stringify(CURSOR_MCP, null, 2), 'utf8');
    const before = readProviderMcpServers(targetFor(filePath));
    for (const server of before) {
      upsertProviderMcpServer(targetFor(filePath), server.name, server, backupDir);
    }
    const after = readProviderMcpServers(targetFor(filePath));
    expect(after).toEqual(before);
  });
});

describe('OpenCode JSON (ключ mcp): local/remote ↔ stdio/http, чужие поля сохранены', () => {
  let root: string;
  let backupDir: string;
  const targetFor = (filePath: string): ProviderMcpTarget => ({
    provider: getProvider('opencode'),
    format: 'opencode-json',
    filePath,
    cliDetected: false,
    jsonHttpUrlKey: 'httpUrl',
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-opencode-mcp-'));
    backupDir = join(root, 'backups');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const OPENCODE_CONFIG = {
    $schema: 'https://opencode.ai/config.json',
    model: 'anthropic/claude-sonnet-4',
    agents: { build: { model: 'x' } },
    mcp: {
      local1: {
        type: 'local',
        command: ['bun', 'x', 'my-mcp-server'],
        environment: { TOKEN: 'abc' },
        enabled: true,
        somethingFuture: { a: 1 },
      },
      remote1: {
        type: 'remote',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer x' },
        enabled: false,
      },
    },
  };

  const writeConfig = (filePath: string): void => {
    writeFileSync(filePath, JSON.stringify(OPENCODE_CONFIG, null, 2), 'utf8');
  };

  it('чтение: local → stdio (command[0] + остальное в args), remote → http', () => {
    const filePath = join(root, 'opencode.json');
    writeConfig(filePath);
    const servers = readProviderMcpServers(targetFor(filePath));
    expect(servers.map((s) => s.name)).toEqual(['local1', 'remote1']);
    expect(servers[0]).toEqual({
      name: 'local1',
      transport: 'stdio',
      command: 'bun',
      args: ['x', 'my-mcp-server'],
      env: { TOKEN: 'abc' },
      url: undefined,
      headers: {},
    });
    expect(servers[1]).toEqual({
      name: 'remote1',
      transport: 'http',
      command: undefined,
      args: [],
      env: {},
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer x' },
    });
  });

  it('запись stdio → type:local + command МАССИВОМ + environment; прочие ключи файла целы', () => {
    const filePath = join(root, 'opencode.json');
    writeConfig(filePath);

    upsertProviderMcpServer(
      targetFor(filePath),
      null,
      {
        name: 'added',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'pkg', '--flag'],
        env: { KEY: 'v' },
        url: undefined,
        headers: {},
      },
      backupDir,
    );
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));

    expect(parsed.$schema).toBe('https://opencode.ai/config.json');
    expect(parsed.model).toBe('anthropic/claude-sonnet-4');
    expect(parsed.agents).toEqual({ build: { model: 'x' } });
    expect(parsed.mcp.added).toEqual({
      type: 'local',
      command: ['npx', '-y', 'pkg', '--flag'],
      environment: { KEY: 'v' },
    });
    // Чужие серверы не тронуты вообще.
    expect(parsed.mcp.local1).toEqual(OPENCODE_CONFIG.mcp.local1);
    expect(parsed.mcp.remote1).toEqual(OPENCODE_CONFIG.mcp.remote1);
  });

  it('правка существующего сервера СОХРАНЯЕТ enabled и неизвестные поля', () => {
    const filePath = join(root, 'opencode.json');
    writeConfig(filePath);

    upsertProviderMcpServer(
      targetFor(filePath),
      'local1',
      {
        name: 'local1',
        transport: 'stdio',
        command: 'bun',
        args: ['x', 'other-server'],
        env: { TOKEN: 'new' },
        url: undefined,
        headers: {},
      },
      backupDir,
    );
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(parsed.mcp.local1).toEqual({
      type: 'local',
      command: ['bun', 'x', 'other-server'],
      environment: { TOKEN: 'new' },
      enabled: true,
      somethingFuture: { a: 1 },
    });
  });

  it('переименование переносит enabled/неизвестные поля на новое имя', () => {
    const filePath = join(root, 'opencode.json');
    writeConfig(filePath);
    upsertProviderMcpServer(
      targetFor(filePath),
      'remote1',
      {
        name: 'renamed',
        transport: 'http',
        command: undefined,
        args: [],
        env: {},
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer x' },
      },
      backupDir,
    );
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(parsed.mcp.remote1).toBeUndefined();
    expect(parsed.mcp.renamed).toEqual({
      type: 'remote',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer x' },
      enabled: false,
    });
  });

  it('смена транспорта local → remote убирает command/environment, но хранит enabled', () => {
    const filePath = join(root, 'opencode.json');
    writeConfig(filePath);
    upsertProviderMcpServer(
      targetFor(filePath),
      'local1',
      {
        name: 'local1',
        transport: 'http',
        command: undefined,
        args: [],
        env: {},
        url: 'https://moved/mcp',
        headers: {},
      },
      backupDir,
    );
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(parsed.mcp.local1).toEqual({
      type: 'remote',
      url: 'https://moved/mcp',
      enabled: true,
      somethingFuture: { a: 1 },
    });
  });

  it('round-trip read→write→read стабилен в обе стороны (local и remote)', () => {
    const filePath = join(root, 'opencode.json');
    writeConfig(filePath);
    const before = readProviderMcpServers(targetFor(filePath));
    for (const server of before) {
      upsertProviderMcpServer(targetFor(filePath), server.name, server, backupDir);
    }
    const after = readProviderMcpServers(targetFor(filePath));
    expect(after).toEqual(before);
    // И сырые записи не потеряли ни enabled, ни будущие поля.
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(parsed.mcp.local1).toEqual(OPENCODE_CONFIG.mcp.local1);
    expect(parsed.mcp.remote1).toEqual(OPENCODE_CONFIG.mcp.remote1);
    expect(parsed.model).toBe('anthropic/claude-sonnet-4');
  });

  it('удаление сервера: прочие ключи файла и второй сервер целы', () => {
    const filePath = join(root, 'opencode.json');
    writeConfig(filePath);
    deleteProviderMcpServer(targetFor(filePath), 'local1', backupDir);
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(Object.keys(parsed.mcp)).toEqual(['remote1']);
    expect(parsed.$schema).toBe('https://opencode.ai/config.json');
    expect(parsed.agents).toEqual({ build: { model: 'x' } });
  });

  it('нет файла → создаётся только с ключом mcp', () => {
    const filePath = join(root, '.config', 'opencode', 'opencode.json');
    upsertProviderMcpServer(
      targetFor(filePath),
      null,
      {
        name: 'only',
        transport: 'stdio',
        command: 'node',
        args: ['s.js'],
        env: {},
        url: undefined,
        headers: {},
      },
      backupDir,
    );
    expect(existsSync(filePath)).toBe(true);
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(Object.keys(parsed)).toEqual(['mcp']);
    expect(parsed.mcp.only).toEqual({ type: 'local', command: ['node', 's.js'] });
  });

  it('битый JSON → fail-closed: чтение бросает, запись отказывает, файл не тронут', () => {
    const filePath = join(root, 'opencode.json');
    const broken = '{ "model": "x", "mcp": {';
    writeFileSync(filePath, broken, 'utf8');
    expect(() => readProviderMcpServers(targetFor(filePath))).toThrow(UnrecognizedFormatError);
    expect(() => deleteProviderMcpServer(targetFor(filePath), 'local1', backupDir)).toThrow(
      UnrecognizedFormatError,
    );
    expect(readFileSync(filePath, 'utf8')).toBe(broken);
  });

  it('повторная запись создаёт резервную копию', () => {
    const filePath = join(root, 'opencode.json');
    writeConfig(filePath);
    const draft = {
      name: 'x',
      transport: 'stdio' as const,
      command: 'node',
      args: [],
      env: {},
      url: undefined,
      headers: {},
    };
    upsertProviderMcpServer(targetFor(filePath), null, draft, backupDir);
    // Вторая запись — правка того же сервера (создание с занятым именем теперь
    // отвечает конфликтом), копия всё равно должна появиться.
    upsertProviderMcpServer(targetFor(filePath), 'x', draft, backupDir);
    expect(readdirSync(backupDir).filter((n) => n.endsWith('.bak')).length).toBeGreaterThanOrEqual(
      1,
    );
  });
});

describe('Kimi JSON (~/.kimi-code/mcp.json): mcpServers с адресом в url', () => {
  let root: string;
  let backupDir: string;
  const targetFor = (filePath: string): ProviderMcpTarget => ({
    provider: getProvider('kimi'),
    format: 'json',
    filePath,
    cliDetected: false,
    jsonHttpUrlKey: 'url',
  });
  const stdioDraft = (name: string) => ({
    name,
    transport: 'stdio' as const,
    command: 'npx',
    args: ['-y', 'pkg'],
    env: { TOKEN: 'abc' },
    url: undefined,
    headers: {},
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-kimi-mcp-'));
    backupDir = join(root, 'backups');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  // Живой mcp.json Kimi: у записей есть свои ключи (`enabled`, таймауты,
  // фильтры инструментов), которых нет в переносимом субсете панели.
  const KIMI_MCP = {
    mcpServers: {
      local: {
        command: 'node',
        args: ['s.js'],
        env: { A: 'b' },
        enabled: true,
        startupTimeoutMs: 15000,
        allowedTools: ['read_file'],
      },
      remote: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } },
    },
  };

  it('чтение: stdio и http (url) распознаны', () => {
    const filePath = join(root, 'mcp.json');
    writeFileSync(filePath, JSON.stringify(KIMI_MCP, null, 2), 'utf8');
    const servers = readProviderMcpServers(targetFor(filePath));
    expect(servers.map((s) => s.name)).toEqual(['local', 'remote']);
    expect(servers[0]).toMatchObject({ transport: 'stdio', command: 'node', env: { A: 'b' } });
    expect(servers[1]).toMatchObject({ transport: 'http', url: 'https://example.com/mcp' });
  });

  it('правка существующего сервера СОХРАНЯЕТ enabled, таймаут и фильтр инструментов', () => {
    const filePath = join(root, 'mcp.json');
    writeFileSync(filePath, JSON.stringify(KIMI_MCP, null, 2), 'utf8');

    upsertProviderMcpServer(
      targetFor(filePath),
      'local',
      { ...stdioDraft('local'), command: 'node', args: ['other.js'] },
      backupDir,
    );
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(parsed.mcpServers.local).toEqual({
      enabled: true,
      startupTimeoutMs: 15000,
      allowedTools: ['read_file'],
      command: 'node',
      args: ['other.js'],
      env: { TOKEN: 'abc' },
    });
    // Второй сервер не тронут.
    expect(parsed.mcpServers.remote).toEqual(KIMI_MCP.mcpServers.remote);
  });

  it('переименование переносит чужие ключи записи на новое имя', () => {
    const filePath = join(root, 'mcp.json');
    writeFileSync(filePath, JSON.stringify(KIMI_MCP, null, 2), 'utf8');
    upsertProviderMcpServer(
      targetFor(filePath),
      'local',
      { ...stdioDraft('renamed'), command: 'node', args: ['s.js'], env: {} },
      backupDir,
    );
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(parsed.mcpServers.local).toBeUndefined();
    expect(parsed.mcpServers.renamed).toMatchObject({
      enabled: true,
      startupTimeoutMs: 15000,
      command: 'node',
    });
  });

  it('http пишется в url (не httpUrl); нет файла → создаётся только с mcpServers', () => {
    const filePath = join(root, '.kimi-code', 'mcp.json');
    upsertProviderMcpServer(
      targetFor(filePath),
      null,
      {
        name: 'r',
        transport: 'http',
        command: undefined,
        args: [],
        env: {},
        url: 'https://e/mcp',
        headers: { A: 'b' },
      },
      backupDir,
    );
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(Object.keys(parsed)).toEqual(['mcpServers']);
    expect(parsed.mcpServers.r).toEqual({ url: 'https://e/mcp', headers: { A: 'b' } });
  });

  it('битый JSON → fail-closed: чтение бросает, запись отказывает, файл не тронут', () => {
    const filePath = join(root, 'mcp.json');
    const broken = '{ "mcpServers": ';
    writeFileSync(filePath, broken, 'utf8');
    expect(() => readProviderMcpServers(targetFor(filePath))).toThrow(UnrecognizedFormatError);
    expect(() =>
      upsertProviderMcpServer(targetFor(filePath), null, stdioDraft('a'), backupDir),
    ).toThrow(UnrecognizedFormatError);
    expect(readFileSync(filePath, 'utf8')).toBe(broken);
  });
});

describe('Формат json: чужие значения проверяются в рантайме (рукописный конфиг)', () => {
  let root: string;
  let backupDir: string;

  const targetFor = (filePath: string): ProviderMcpTarget => ({
    provider: getProvider('gemini'),
    format: 'json',
    filePath,
    cliDetected: false,
    jsonHttpUrlKey: 'httpUrl',
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-json-mcp-raw-'));
    backupDir = join(root, 'backups');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  // Человек написал args строкой, env числом, headers массивом. Раньше эти
  // значения уезжали в API как есть — страница падала на `args.join(' ')`.
  it('нестроковые args/env/headers/command не выдаются за string[]/Record', () => {
    const filePath = join(root, 'settings.json');
    writeFileSync(
      filePath,
      JSON.stringify({
        mcpServers: {
          handwritten: {
            command: 'npx',
            args: '-y pkg',
            env: { OK: 'yes', PORT: 8080 },
            headers: ['A: b'],
          },
          weird: { command: 42, args: [1, 'ok', null] },
        },
      }),
      'utf8',
    );

    const servers = readProviderMcpServers(targetFor(filePath));
    expect(servers.find((s) => s.name === 'handwritten')).toEqual({
      name: 'handwritten',
      transport: 'stdio',
      command: 'npx',
      args: [],
      env: {},
      url: undefined,
      headers: {},
    });
    const weird = servers.find((s) => s.name === 'weird')!;
    expect(weird.command).toBeUndefined();
    expect(weird.args).toEqual(['ok']);
  });

  it('нестроковый httpUrl не подменяет транспорт: адрес берётся из url', () => {
    const filePath = join(root, 'settings.json');
    writeFileSync(
      filePath,
      JSON.stringify({ mcpServers: { r: { httpUrl: 123, url: 'https://e/mcp' } } }),
      'utf8',
    );
    expect(readProviderMcpServers(targetFor(filePath))[0]).toMatchObject({
      transport: 'http',
      url: 'https://e/mcp',
    });
  });

  it('запись сервера строкой вместо объекта не разбирается по символам', () => {
    const filePath = join(root, 'settings.json');
    writeFileSync(filePath, JSON.stringify({ mcpServers: { s: 'npx -y pkg' } }), 'utf8');
    expect(readProviderMcpServers(targetFor(filePath))[0]).toMatchObject({
      name: 's',
      transport: 'stdio',
      command: undefined,
      args: [],
    });

    upsertProviderMcpServer(
      targetFor(filePath),
      's',
      {
        name: 's',
        transport: 'stdio',
        command: 'npx',
        args: [],
        env: {},
        url: undefined,
        headers: {},
      },
      backupDir,
    );
    expect(JSON.parse(readFileSync(filePath, 'utf8')).mcpServers.s).toEqual({ command: 'npx' });
  });

  it('mcpServers не отображение → fail-closed на чтении и записи, файл цел', () => {
    const filePath = join(root, 'settings.json');
    const text = JSON.stringify({ mcpServers: ['github'] });
    writeFileSync(filePath, text, 'utf8');
    expect(() => readProviderMcpServers(targetFor(filePath))).toThrow(UnrecognizedFormatError);
    expect(() =>
      upsertProviderMcpServer(
        targetFor(filePath),
        null,
        {
          name: 'a',
          transport: 'stdio',
          command: 'npx',
          args: [],
          env: {},
          url: undefined,
          headers: {},
        },
        backupDir,
      ),
    ).toThrow(UnrecognizedFormatError);
    expect(readFileSync(filePath, 'utf8')).toBe(text);
  });
});

describe('Занятое имя сервера: конфликт вместо записи поверх', () => {
  let root: string;
  let backupDir: string;

  const draft = (name: string, command: string) => ({
    name,
    transport: 'stdio' as const,
    command,
    args: [],
    env: {},
    url: undefined,
    headers: {},
  });

  const jsonTarget = (filePath: string): ProviderMcpTarget => ({
    provider: getProvider('gemini'),
    format: 'json',
    filePath,
    cliDetected: false,
    jsonHttpUrlKey: 'httpUrl',
  });

  const codexTarget = (filePath: string): ProviderMcpTarget => ({
    provider: getProvider('codex'),
    format: 'toml',
    filePath,
    cliDetected: false,
    jsonHttpUrlKey: 'httpUrl',
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-mcp-exists-'));
    backupDir = join(root, 'backups');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('создание с занятым именем (json) → McpServerExistsError, прежний сервер цел', () => {
    const filePath = join(root, 'settings.json');
    const text = JSON.stringify({ mcpServers: { github: { command: 'node', args: ['s.js'] } } });
    writeFileSync(filePath, text, 'utf8');

    expect(() =>
      upsertProviderMcpServer(jsonTarget(filePath), null, draft('github', 'npx'), backupDir),
    ).toThrow(McpServerExistsError);
    expect(readFileSync(filePath, 'utf8')).toBe(text);
  });

  it('переименование в занятое имя (json) → конфликт, оба сервера целы', () => {
    const filePath = join(root, 'settings.json');
    const text = JSON.stringify({
      mcpServers: { github: { command: 'node' }, gh: { command: 'npx' } },
    });
    writeFileSync(filePath, text, 'utf8');

    expect(() =>
      upsertProviderMcpServer(jsonTarget(filePath), 'gh', draft('github', 'npx'), backupDir),
    ).toThrow(McpServerExistsError);
    expect(readFileSync(filePath, 'utf8')).toBe(text);
  });

  it('правка сервера под тем же именем конфликтом не считается', () => {
    const filePath = join(root, 'settings.json');
    writeFileSync(
      filePath,
      JSON.stringify({ mcpServers: { github: { command: 'node' } } }),
      'utf8',
    );
    upsertProviderMcpServer(jsonTarget(filePath), 'github', draft('github', 'npx'), backupDir);
    expect(JSON.parse(readFileSync(filePath, 'utf8')).mcpServers.github).toEqual({
      command: 'npx',
    });
  });

  it('осознанная замена (перенос между провайдерами) проходит с allowOverwrite', () => {
    const filePath = join(root, 'settings.json');
    writeFileSync(
      filePath,
      JSON.stringify({ mcpServers: { github: { command: 'node' } } }),
      'utf8',
    );
    upsertProviderMcpServer(jsonTarget(filePath), null, draft('github', 'npx'), backupDir, {
      allowOverwrite: true,
    });
    expect(JSON.parse(readFileSync(filePath, 'utf8')).mcpServers.github).toEqual({
      command: 'npx',
    });
  });

  it('тот же отказ у codex (проверка в диспетчере, а не в одном адаптере)', () => {
    const filePath = join(root, 'config.toml');
    const text = '[mcp_servers.github]\ncommand = "node"\n';
    writeFileSync(filePath, text, 'utf8');

    expect(() =>
      upsertProviderMcpServer(codexTarget(filePath), null, draft('github', 'npx'), backupDir),
    ).toThrow(McpServerExistsError);
    expect(readFileSync(filePath, 'utf8')).toBe(text);
  });

  it('создание с новым именем не задето', () => {
    const filePath = join(root, 'settings.json');
    writeFileSync(
      filePath,
      JSON.stringify({ mcpServers: { github: { command: 'node' } } }),
      'utf8',
    );
    upsertProviderMcpServer(jsonTarget(filePath), null, draft('tavily', 'npx'), backupDir);
    expect(Object.keys(JSON.parse(readFileSync(filePath, 'utf8')).mcpServers).sort()).toEqual([
      'github',
      'tavily',
    ]);
  });
});
