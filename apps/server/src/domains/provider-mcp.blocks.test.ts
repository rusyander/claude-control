import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { getProvider } from '../providers/registry.ts';
import {
  readProviderMcpSection,
  upsertProviderMcpServer,
  deleteProviderMcpServer,
  type ProviderMcpTarget,
} from './provider-mcp.ts';

/**
 * Файлы-блоки Continue: `mcpServers/*.yaml` рядом с `config.yaml`.
 *
 * Continue грузит их вместе с основным конфигом. Пока панель их не видела,
 * сервер, заведённый блоком, выглядел отсутствующим: человек заводил дубль, а
 * CLI поднимал оба. Проверяем то, ради чего это сделано: блок виден в списке,
 * правка и удаление идут В ЕГО файл (а не в config.yaml), непонятный блок
 * пропускается ПОФАЙЛОВО с причиной, а раздел продолжает работать.
 */
describe('Continue: MCP-серверы из файлов-блоков mcpServers/*.yaml', () => {
  let root: string;
  let blockDir: string;
  let configPath: string;
  let backupDir: string;

  const CONFIG = `name: my assistant
version: 1.0.0
models:
  - name: sonnet
    provider: anthropic
mcpServers:
  - name: sqlite
    command: uvx
    args: [mcp-server-sqlite]
`;

  const BLOCK = `name: Playwright mcpServer
version: 0.0.1
schema: v1
# комментарий шапки — обязан уцелеть
mcpServers:
  - name: browser
    command: npx
    args: ["@playwright/mcp@latest"]
`;

  const target = (): ProviderMcpTarget => ({
    provider: getProvider('continue'),
    format: 'continue-yaml',
    filePath: configPath,
    cliDetected: false,
    jsonHttpUrlKey: 'url',
    blockDir,
  });

  const block = (name: string, text: string): string => {
    const path = join(blockDir, name);
    writeFileSync(path, text);
    return path;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-continue-blocks-'));
    blockDir = join(root, 'mcpServers');
    mkdirSync(blockDir, { recursive: true });
    configPath = join(root, 'config.yaml');
    backupDir = join(root, 'backups');
    writeFileSync(configPath, CONFIG);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('серверы блока показываются вместе с серверами config.yaml и несут свой файл', () => {
    const path = block('playwright.yaml', BLOCK);

    const section = readProviderMcpSection(target());

    expect(section.servers.map((server) => server.name)).toEqual(['browser', 'sqlite']);
    expect(section.servers.find((server) => server.name === 'browser')?.sourceFile).toBe(path);
    // Запись основного файла остаётся без пометки: её файл и так известен.
    expect(section.servers.find((server) => server.name === 'sqlite')?.sourceFile).toBeUndefined();
    expect(section.skippedBlocks).toEqual([]);
  });

  it('правка записи блока идёт в ЕГО файл, config.yaml не трогается', () => {
    const path = block('playwright.yaml', BLOCK);

    upsertProviderMcpServer(
      target(),
      'browser',
      {
        name: 'browser',
        transport: 'stdio',
        command: 'npx',
        args: ['@playwright/mcp@2'],
        env: {},
        headers: {},
      },
      backupDir,
    );

    const written = readFileSync(path, 'utf8');
    expect(parseYaml(written).mcpServers[0].args).toEqual(['@playwright/mcp@2']);
    // Шапка блока и комментарий над списком целы.
    expect(parseYaml(written).schema).toBe('v1');
    expect(written).toContain('# комментарий шапки');
    // В основной файл запись не переехала — иначе Continue грузил бы две копии.
    expect(readFileSync(configPath, 'utf8')).toBe(CONFIG);
  });

  it('удаление записи блока убирает её из блока, а не из config.yaml', () => {
    const path = block('playwright.yaml', BLOCK);

    deleteProviderMcpServer(target(), 'browser', backupDir);

    // Файл остаётся: сносить чужой файл молча нечем откатить в интерфейсе.
    expect(existsSync(path)).toBe(true);
    const written = parseYaml(readFileSync(path, 'utf8'));
    expect(written.mcpServers).toBeUndefined();
    expect(written.name).toBe('Playwright mcpServer');
    expect(readProviderMcpSection(target()).servers.map((s) => s.name)).toEqual(['sqlite']);
  });

  it('новый сервер идёт в config.yaml: своих файлов-блоков панель не заводит', () => {
    block('playwright.yaml', BLOCK);

    upsertProviderMcpServer(
      target(),
      null,
      { name: 'ripgrep', transport: 'stdio', command: 'rg', args: [], env: {}, headers: {} },
      backupDir,
    );

    const config = parseYaml(readFileSync(configPath, 'utf8'));
    expect(config.mcpServers.map((s: { name: string }) => s.name)).toEqual(['sqlite', 'ripgrep']);
    expect(
      parseYaml(readFileSync(join(blockDir, 'playwright.yaml'), 'utf8')).mcpServers,
    ).toHaveLength(1);
  });

  it('блок со ссылкой `uses:` (запись без имени) пропускается с причиной, раздел жив', () => {
    const path = block(
      'hub.yaml',
      'name: hub\nversion: 0.0.1\nschema: v1\nmcpServers:\n  - uses: continuedev/docs\n',
    );
    block('playwright.yaml', BLOCK);

    const section = readProviderMcpSection(target());

    expect(section.servers.map((s) => s.name)).toEqual(['browser', 'sqlite']);
    expect(section.skippedBlocks.map((item) => item.path)).toEqual([path]);
    expect(section.skippedBlocks[0]!.reason).toMatch(/не разбирается/i);
  });

  it('блок с именем, уже занятым config.yaml, пропускается целиком — запись не адресуема', () => {
    const path = block(
      'dup.yaml',
      'name: dup\nversion: 0.0.1\nschema: v1\nmcpServers:\n  - name: sqlite\n    command: other\n',
    );

    const section = readProviderMcpSection(target());

    expect(section.servers.map((s) => s.name)).toEqual(['sqlite']);
    // Победил основной файл — панель ведёт его, а не чужой блок.
    expect(section.servers[0]!.command).toBe('uvx');
    expect(section.skippedBlocks.map((item) => item.path)).toEqual([path]);
    expect(section.skippedBlocks[0]!.reason).toMatch(/уже занято/i);
  });

  it('в пропущенный блок панель не пишет: правка одноимённой записи идёт в config.yaml', () => {
    const path = block(
      'dup.yaml',
      'name: dup\nversion: 0.0.1\nschema: v1\nmcpServers:\n  - name: sqlite\n    command: other\n',
    );
    const before = readFileSync(path, 'utf8');

    upsertProviderMcpServer(
      target(),
      'sqlite',
      { name: 'sqlite', transport: 'stdio', command: 'uvx2', args: [], env: {}, headers: {} },
      backupDir,
    );

    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(parseYaml(readFileSync(configPath, 'utf8')).mcpServers[0].command).toBe('uvx2');
  });

  it('нет каталога блоков — раздел работает как раньше', () => {
    rmSync(blockDir, { recursive: true, force: true });

    const section = readProviderMcpSection(target());

    expect(section.servers.map((s) => s.name)).toEqual(['sqlite']);
    expect(section.skippedBlocks).toEqual([]);
  });

  it('файлы блоков читаются в устойчивом порядке, .yml тоже', () => {
    block(
      'b.yml',
      'name: b\nversion: 0.0.1\nschema: v1\nmcpServers:\n  - name: beta\n    command: b\n',
    );
    block(
      'a.yaml',
      'name: a\nversion: 0.0.1\nschema: v1\nmcpServers:\n  - name: alpha\n    command: a\n',
    );
    // Посторонний файл в папке (JSON-конфиг проекта) блоком не считается.
    block('mcp.json', '{"mcpServers":{"json-one":{"command":"j"}}}');

    const section = readProviderMcpSection(target());

    expect(section.servers.map((s) => s.name)).toEqual(['alpha', 'beta', 'sqlite']);
    expect(section.skippedBlocks).toEqual([]);
  });
});
