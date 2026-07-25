import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { getProvider } from '../providers/registry.ts';
import {
  resolveProviderMcpTarget,
  readProviderMcpServers,
  upsertProviderMcpServer,
  deleteProviderMcpServer,
  UnrecognizedFormatError,
  type ProviderMcpTarget,
} from './provider-mcp.ts';

/**
 * MCP Continue — единственная форма-СПИСОК среди провайдеров: `mcpServers` в
 * `~/.continue/config.yaml` это не «имя → запись», а массив записей, у каждой
 * имя лежит ВНУТРИ полем `name`. Проверяем ровно то, что отличает эту форму:
 * адресация и переименование по `name`, транспорт по `type`, заголовки в
 * `requestOptions.headers`, сохранность прочих ключей файла и комментариев вне
 * блока, и fail-closed на любой чужой форме. Файлы — только временные.
 */
describe('Continue config.yaml: MCP списком записей с именем внутри', () => {
  let root: string;
  let backupDir: string;

  const targetFor = (filePath: string): ProviderMcpTarget => ({
    provider: getProvider('continue'),
    format: 'continue-yaml',
    filePath,
    cliDetected: false,
    jsonHttpUrlKey: 'url',
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-continue-mcp-'));
    backupDir = join(root, 'backups');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  // Живой config.yaml: модели, правила, комментарии — панель ведёт только блок
  // mcpServers, всё прочее обязано пережить запись.
  const CONFIG = `name: my assistant
version: 1.0.0
# комментарий над моделями — обязан уцелеть
models:
  - name: sonnet
    provider: anthropic
rules:
  - Always write tests
mcpServers:
  - name: sqlite
    command: uvx
    args: [mcp-server-sqlite, --db-path, ./test.db]
    cwd: /home/user/project
    env:
      NODE_ENV: production
  - name: remote-docs
    type: streamable-http
    url: https://example.com/mcp
    requestOptions:
      timeout: 5000
      headers:
        Authorization: Bearer abc
`;

  const writeConfig = (filePath: string): void => writeFileSync(filePath, CONFIG, 'utf8');
  const parsed = (filePath: string) => parseYaml(readFileSync(filePath, 'utf8'));

  it('цель провайдера — формат continue-yaml по пути ~/.continue/config.yaml', () => {
    expect(
      resolveProviderMcpTarget({
        getSettings: () => ({ provider: 'continue', claudeDirOverride: '' }),
      }),
    ).toMatchObject({
      format: 'continue-yaml',
      filePath: join(homedir(), '.continue', 'config.yaml'),
    });
  });

  it('чтение: имя из поля name, транспорт по type, заголовки из requestOptions', () => {
    const filePath = join(root, 'config.yaml');
    writeConfig(filePath);
    const servers = readProviderMcpServers(targetFor(filePath));
    // Отсортировано по имени, а не по порядку в файле.
    expect(servers.map((s) => s.name)).toEqual(['remote-docs', 'sqlite']);
    expect(servers[1]).toEqual({
      name: 'sqlite',
      transport: 'stdio',
      command: 'uvx',
      args: ['mcp-server-sqlite', '--db-path', './test.db'],
      env: { NODE_ENV: 'production' },
      url: undefined,
      headers: {},
    });
    expect(servers[0]).toEqual({
      name: 'remote-docs',
      transport: 'http',
      command: undefined,
      args: [],
      env: {},
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer abc' },
    });
  });

  it('нет файла → пустой список, файл не создаётся чтением', () => {
    const filePath = join(root, 'absent.yaml');
    expect(readProviderMcpServers(targetFor(filePath))).toEqual([]);
  });

  it('добавление stdio: запись в конец списка, прочие ключи и комментарии целы', () => {
    const filePath = join(root, 'config.yaml');
    writeConfig(filePath);

    upsertProviderMcpServer(
      targetFor(filePath),
      null,
      {
        name: 'added',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'pkg'],
        env: { KEY: 'v' },
        url: undefined,
        headers: {},
      },
      backupDir,
    );

    const config = parsed(filePath);
    expect(config.name).toBe('my assistant');
    expect(config.models).toEqual([{ name: 'sonnet', provider: 'anthropic' }]);
    expect(config.rules).toEqual(['Always write tests']);
    expect(config.mcpServers.map((s: { name: string }) => s.name)).toEqual([
      'sqlite',
      'remote-docs',
      'added',
    ]);
    expect(config.mcpServers[2]).toEqual({
      name: 'added',
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'pkg'],
      env: { KEY: 'v' },
    });
    // Комментарий вне блока mcpServers переживает правку.
    expect(readFileSync(filePath, 'utf8')).toContain('# комментарий над моделями');
  });

  it('правка существующей записи сохраняет чужие поля (cwd) и место в списке', () => {
    const filePath = join(root, 'config.yaml');
    writeConfig(filePath);

    upsertProviderMcpServer(
      targetFor(filePath),
      'sqlite',
      {
        name: 'sqlite',
        transport: 'stdio',
        command: 'uvx',
        args: ['mcp-server-sqlite'],
        env: {},
        url: undefined,
        headers: {},
      },
      backupDir,
    );

    const config = parsed(filePath);
    expect(config.mcpServers[0]).toEqual({
      name: 'sqlite',
      type: 'stdio',
      command: 'uvx',
      args: ['mcp-server-sqlite'],
      // Немоделируемое поле перенесено по значению.
      cwd: '/home/user/project',
    });
    expect(config.mcpServers[1].name).toBe('remote-docs');
  });

  it('правка удалённой записи: тип sse НЕ переписывается, прочий requestOptions цел', () => {
    const filePath = join(root, 'sse.yaml');
    writeFileSync(
      filePath,
      `mcpServers:\n  - name: legacy\n    type: sse\n    url: https://old.example/mcp\n    requestOptions:\n      timeout: 1000\n      headers:\n        A: b\n`,
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
        headers: { A: 'c' },
      },
      backupDir,
    );

    expect(parsed(filePath).mcpServers[0]).toEqual({
      name: 'legacy',
      type: 'sse',
      url: 'https://new.example/mcp',
      requestOptions: { timeout: 1000, headers: { A: 'c' } },
    });
  });

  it('новый удалённый сервер получает основной транспорт streamable-http', () => {
    const filePath = join(root, 'fresh.yaml');
    upsertProviderMcpServer(
      targetFor(filePath),
      null,
      {
        name: 'docs',
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
      mcpServers: [
        {
          name: 'docs',
          type: 'streamable-http',
          url: 'https://example.com/mcp',
          requestOptions: { headers: { Authorization: 'Bearer x' } },
        },
      ],
    });
  });

  it('переименование: старая запись НЕ дублируется, соседи целы', () => {
    const filePath = join(root, 'config.yaml');
    writeConfig(filePath);

    upsertProviderMcpServer(
      targetFor(filePath),
      'sqlite',
      {
        name: 'sqlite-renamed',
        transport: 'stdio',
        command: 'uvx',
        args: [],
        env: {},
        url: undefined,
        headers: {},
      },
      backupDir,
    );

    const names = parsed(filePath).mcpServers.map((s: { name: string }) => s.name);
    expect(names).toEqual(['sqlite-renamed', 'remote-docs']);
  });

  it('удаление последней записи убирает ключ mcpServers целиком (а не пишет [])', () => {
    const filePath = join(root, 'one.yaml');
    writeFileSync(filePath, `name: solo\nmcpServers:\n  - name: only\n    command: node\n`, 'utf8');

    deleteProviderMcpServer(targetFor(filePath), 'only', backupDir);

    const text = readFileSync(filePath, 'utf8');
    expect(text).not.toContain('mcpServers');
    expect(parsed(filePath)).toEqual({ name: 'solo' });
  });

  it('удаление одной из двух не трогает вторую', () => {
    const filePath = join(root, 'config.yaml');
    writeConfig(filePath);
    deleteProviderMcpServer(targetFor(filePath), 'sqlite', backupDir);
    expect(parsed(filePath).mcpServers.map((s: { name: string }) => s.name)).toEqual([
      'remote-docs',
    ]);
  });

  it('битый YAML: чтение и запись fail-closed, файл байт-в-байт', () => {
    const filePath = join(root, 'broken.yaml');
    const broken = 'mcpServers:\n  - name: x\n   command: [oops\n';
    writeFileSync(filePath, broken, 'utf8');

    expect(() => readProviderMcpServers(targetFor(filePath))).toThrow(UnrecognizedFormatError);
    expect(() => deleteProviderMcpServer(targetFor(filePath), 'x', backupDir)).toThrow(
      UnrecognizedFormatError,
    );
    expect(readFileSync(filePath, 'utf8')).toBe(broken);
  });

  it('чужая форма блока — fail-closed: карта вместо списка, запись без имени, повтор имени', () => {
    const asMap = join(root, 'map.yaml');
    writeFileSync(asMap, `mcpServers:\n  srv:\n    command: node\n`, 'utf8');
    expect(() => readProviderMcpServers(targetFor(asMap))).toThrow(UnrecognizedFormatError);

    const noName = join(root, 'noname.yaml');
    writeFileSync(noName, `mcpServers:\n  - command: node\n`, 'utf8');
    expect(() => readProviderMcpServers(targetFor(noName))).toThrow(UnrecognizedFormatError);

    const duplicate = join(root, 'dup.yaml');
    writeFileSync(duplicate, `mcpServers:\n  - name: a\n  - name: a\n`, 'utf8');
    expect(() => readProviderMcpServers(targetFor(duplicate))).toThrow(UnrecognizedFormatError);

    // Корень не отображение — тоже не наша форма.
    const scalarRoot = join(root, 'scalar.yaml');
    writeFileSync(scalarRoot, `- just\n- a\n- list\n`, 'utf8');
    expect(() => readProviderMcpServers(targetFor(scalarRoot))).toThrow(UnrecognizedFormatError);
  });

  it('round-trip: чтение → перезапись каждой записи → чтение стабильно', () => {
    const filePath = join(root, 'config.yaml');
    writeConfig(filePath);
    const before = readProviderMcpServers(targetFor(filePath));
    for (const server of before) {
      upsertProviderMcpServer(targetFor(filePath), server.name, server, backupDir);
    }
    expect(readProviderMcpServers(targetFor(filePath))).toEqual(before);
  });
});
