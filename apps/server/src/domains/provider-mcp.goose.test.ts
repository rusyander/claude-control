import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { getProvider } from '../providers/registry.ts';
import {
  readProviderMcpServers,
  upsertProviderMcpServer,
  deleteProviderMcpServer,
  UnrecognizedFormatError,
  type ProviderMcpTarget,
} from './provider-mcp.ts';

/**
 * MCP Goose — блок `extensions` файла `config.yaml`: отображение «имя → запись»,
 * где рядом с внешними серверами лежат ВСТРОЕННЫЕ расширения самого CLI
 * (`developer`, `memory`). Главное, что проверяем: встроенные не показываются,
 * не правятся и не затираются; внешние читаются по `type`; чужие поля записи
 * переживают round-trip; битый или незнакомый файл не перезаписывается.
 */
describe('Goose config.yaml: расширения как MCP-серверы', () => {
  let root: string;
  let backupDir: string;

  const targetFor = (filePath: string): ProviderMcpTarget => ({
    provider: getProvider('goose'),
    format: 'goose-yaml',
    filePath,
    cliDetected: false,
    jsonHttpUrlKey: 'url',
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-goose-mcp-'));
    backupDir = join(root, 'backups');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  // Живой config.yaml: провайдер, модель, режим аппрувов, встроенные расширения
  // и два внешних сервера — stdio и удалённый.
  const CONFIG = `GOOSE_PROVIDER: anthropic
GOOSE_MODE: smart_approve
# комментарий над расширениями — обязан уцелеть
extensions:
  developer:
    type: builtin
    name: developer
    bundled: true
    enabled: true
    timeout: 300
  tavily:
    type: stdio
    name: tavily
    cmd: npx
    args: [-y, mcp-tavily-search]
    envs:
      TAVILY_API_KEY: key-here
    enabled: true
    timeout: 300
  docs:
    type: streamable_http
    name: docs
    uri: https://example.com/mcp
    headers:
      Authorization: Bearer abc
    enabled: true
`;

  const writeConfig = (filePath: string): void => writeFileSync(filePath, CONFIG, 'utf8');
  const parsed = (filePath: string) => parseYaml(readFileSync(filePath, 'utf8'));

  it('чтение: встроенные расширения не показываются, внешние — по типу', () => {
    const filePath = join(root, 'config.yaml');
    writeConfig(filePath);
    const servers = readProviderMcpServers(targetFor(filePath));
    // developer (builtin) в список НЕ попал.
    expect(servers.map((s) => s.name)).toEqual(['docs', 'tavily']);
    expect(servers[1]).toEqual({
      name: 'tavily',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'mcp-tavily-search'],
      env: { TAVILY_API_KEY: 'key-here' },
      url: undefined,
      headers: {},
    });
    expect(servers[0]).toEqual({
      name: 'docs',
      transport: 'http',
      command: undefined,
      args: [],
      env: {},
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer abc' },
    });
  });

  it('нет файла → пустой список, файл не создаётся чтением', () => {
    expect(readProviderMcpServers(targetFor(join(root, 'absent.yaml')))).toEqual([]);
  });

  it('добавление stdio: enabled:true у новой записи, прочие ключи и комментарии целы', () => {
    const filePath = join(root, 'config.yaml');
    writeConfig(filePath);

    upsertProviderMcpServer(
      targetFor(filePath),
      null,
      {
        name: 'added',
        transport: 'stdio',
        command: 'uvx',
        args: ['mcp-server-sqlite'],
        env: { KEY: 'v' },
        url: undefined,
        headers: {},
      },
      backupDir,
    );

    const config = parsed(filePath);
    expect(config.GOOSE_PROVIDER).toBe('anthropic');
    expect(config.GOOSE_MODE).toBe('smart_approve');
    expect(config.extensions.added).toEqual({
      type: 'stdio',
      name: 'added',
      cmd: 'uvx',
      args: ['mcp-server-sqlite'],
      envs: { KEY: 'v' },
      enabled: true,
    });
    // Встроенное расширение не тронуто вообще.
    expect(config.extensions.developer).toEqual({
      type: 'builtin',
      name: 'developer',
      bundled: true,
      enabled: true,
      timeout: 300,
    });
    expect(readFileSync(filePath, 'utf8')).toContain('# комментарий над расширениями');
  });

  it('правка существующего сервера сохраняет timeout/enabled и не двигает соседей', () => {
    const filePath = join(root, 'config.yaml');
    writeConfig(filePath);

    upsertProviderMcpServer(
      targetFor(filePath),
      'tavily',
      {
        name: 'tavily',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'mcp-tavily-search', '--verbose'],
        env: {},
        url: undefined,
        headers: {},
      },
      backupDir,
    );

    const config = parsed(filePath);
    expect(config.extensions.tavily).toEqual({
      type: 'stdio',
      name: 'tavily',
      cmd: 'npx',
      args: ['-y', 'mcp-tavily-search', '--verbose'],
      // Немоделируемые поля перенесены по значению.
      enabled: true,
      timeout: 300,
    });
    expect(Object.keys(config.extensions)).toEqual(['developer', 'tavily', 'docs']);
  });

  it('новый удалённый сервер получает streamable_http; заголовки в headers', () => {
    const filePath = join(root, 'fresh.yaml');
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
    expect(parsed(filePath)).toEqual({
      extensions: {
        remote: {
          type: 'streamable_http',
          name: 'remote',
          uri: 'https://example.com/mcp',
          headers: { Authorization: 'Bearer x' },
          enabled: true,
        },
      },
    });
  });

  it('прежний тип sse не переписывается на streamable_http', () => {
    const filePath = join(root, 'sse.yaml');
    writeFileSync(
      filePath,
      `extensions:\n  legacy:\n    type: sse\n    name: legacy\n    uri: https://old.example/mcp\n    enabled: true\n`,
      'utf8',
    );

    upsertProviderMcpServer(
      targetFor(filePath),
      'legacy',
      {
        name: 'legacy',
        transport: 'http',
        command: undefined,
        args: [],
        env: {},
        url: 'https://new.example/mcp',
        headers: {},
      },
      backupDir,
    );
    expect(parsed(filePath).extensions.legacy).toEqual({
      type: 'sse',
      name: 'legacy',
      uri: 'https://new.example/mcp',
      enabled: true,
    });
  });

  it('переименование сохраняет место записи и правит поле name внутри', () => {
    const filePath = join(root, 'config.yaml');
    writeConfig(filePath);

    upsertProviderMcpServer(
      targetFor(filePath),
      'tavily',
      {
        name: 'search',
        transport: 'stdio',
        command: 'npx',
        args: [],
        env: {},
        url: undefined,
        headers: {},
      },
      backupDir,
    );

    const config = parsed(filePath);
    expect(Object.keys(config.extensions)).toEqual(['developer', 'search', 'docs']);
    expect(config.extensions.search.name).toBe('search');
  });

  it('встроенное расширение НЕЛЬЗЯ затереть, переименовать в него и удалить', () => {
    const filePath = join(root, 'config.yaml');
    writeConfig(filePath);
    const before = readFileSync(filePath, 'utf8');

    const draft = {
      name: 'developer',
      transport: 'stdio' as const,
      command: 'npx',
      args: [],
      env: {},
      url: undefined,
      headers: {},
    };
    // Прямая запись поверх встроенного.
    expect(() => upsertProviderMcpServer(targetFor(filePath), null, draft, backupDir)).toThrow(
      UnrecognizedFormatError,
    );
    // Переименование чужого сервера в имя встроенного.
    expect(() => upsertProviderMcpServer(targetFor(filePath), 'tavily', draft, backupDir)).toThrow(
      UnrecognizedFormatError,
    );
    // И удаление встроенного.
    expect(() => deleteProviderMcpServer(targetFor(filePath), 'developer', backupDir)).toThrow(
      UnrecognizedFormatError,
    );
    expect(readFileSync(filePath, 'utf8')).toBe(before);
  });

  it('удаление внешнего сервера не трогает встроенные и соседей', () => {
    const filePath = join(root, 'config.yaml');
    writeConfig(filePath);
    deleteProviderMcpServer(targetFor(filePath), 'docs', backupDir);
    expect(Object.keys(parsed(filePath).extensions)).toEqual(['developer', 'tavily']);
  });

  it('удаление последнего расширения убирает ключ extensions целиком', () => {
    const filePath = join(root, 'one.yaml');
    writeFileSync(
      filePath,
      `GOOSE_MODE: chat\nextensions:\n  only:\n    type: stdio\n    name: only\n    cmd: node\n`,
      'utf8',
    );
    deleteProviderMcpServer(targetFor(filePath), 'only', backupDir);
    const text = readFileSync(filePath, 'utf8');
    expect(text).not.toContain('extensions');
    expect(parseYaml(text)).toEqual({ GOOSE_MODE: 'chat' });
  });

  it('битый YAML: чтение и запись fail-closed, файл байт-в-байт', () => {
    const filePath = join(root, 'broken.yaml');
    const broken = 'extensions:\n  x:\n   type: [stdio\n';
    writeFileSync(filePath, broken, 'utf8');

    expect(() => readProviderMcpServers(targetFor(filePath))).toThrow(UnrecognizedFormatError);
    expect(() => deleteProviderMcpServer(targetFor(filePath), 'x', backupDir)).toThrow(
      UnrecognizedFormatError,
    );
    expect(readFileSync(filePath, 'utf8')).toBe(broken);
  });

  it('чужая форма блока — fail-closed: список вместо карты, запись не отображение', () => {
    const asList = join(root, 'list.yaml');
    writeFileSync(asList, `extensions:\n  - name: srv\n    cmd: node\n`, 'utf8');
    expect(() => readProviderMcpServers(targetFor(asList))).toThrow(UnrecognizedFormatError);

    const scalarEntry = join(root, 'scalar.yaml');
    writeFileSync(scalarEntry, `extensions:\n  srv: node\n`, 'utf8');
    expect(() => readProviderMcpServers(targetFor(scalarEntry))).toThrow(UnrecognizedFormatError);
  });

  it('round-trip: чтение → перезапись каждого сервера → чтение стабильно', () => {
    const filePath = join(root, 'config.yaml');
    writeConfig(filePath);
    const before = readProviderMcpServers(targetFor(filePath));
    for (const server of before) {
      upsertProviderMcpServer(targetFor(filePath), server.name, server, backupDir);
    }
    expect(readProviderMcpServers(targetFor(filePath))).toEqual(before);
    // И встроенное расширение на месте после всех правок.
    expect(parsed(filePath).extensions.developer.type).toBe('builtin');
  });
});
