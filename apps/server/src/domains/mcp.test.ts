import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../lib/app-store.ts';
import { readMcpServers, saveMcpServer } from './mcp.ts';

/**
 * Чтение и запись регистрации MCP-серверов.
 *
 * Главное здесь — что файл чужой: ~/.claude.json правят и Claude Code, и сам
 * пользователь руками, и другие панели. Значит, в поле type может лежать что
 * угодно, а поведение при этом должно остаться предсказуемым: транспорт
 * выбирает способ подключения, и мусор в нём раньше доезжал до клиента
 * невнятным отказом.
 *
 * Всё пишется во временный каталог — настоящий ~/.claude.json не затрагивается.
 */
describe('mcp', () => {
  let dir: string;
  let configPath: string;
  let store: AppStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-mcp-config-'));
    configPath = join(dir, 'claude.json');

    // См. hooks.test.ts: свежий AppStore без готового state.json делит массивы
    // с модульным DEFAULT_STATE по ссылке, и тесты протекают друг в друга.
    const appDataDir = join(dir, 'claude-control');
    mkdirSync(appDataDir, { recursive: true });
    writeFileSync(
      appDataDir + '/state.json',
      JSON.stringify({
        groups: [],
        automations: [],
        disabled: { rule: [], hook: [], skill: [], mcp: [], permission: [] },
      }),
    );
    store = new AppStore(appDataDir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const writeConfig = (mcpServers: Record<string, unknown>) =>
    writeFileSync(configPath, JSON.stringify({ mcpServers }, null, 2));

  const readServer = (name: string) =>
    readMcpServers(configPath, store).find((server) => server.id === name);

  describe('транспорт', () => {
    it('известные значения проходят как есть', () => {
      writeConfig({
        one: { type: 'stdio', command: 'npx' },
        two: { type: 'http', url: 'https://example.test/mcp' },
        three: { type: 'sse', url: 'https://example.test/sse' },
      });

      expect(readServer('one')?.transport).toBe('stdio');
      expect(readServer('two')?.transport).toBe('http');
      expect(readServer('three')?.transport).toBe('sse');
    });

    it('без type транспорт угадывается по наличию адреса', () => {
      writeConfig({
        byCommand: { command: 'npx' },
        byUrl: { url: 'https://example.test/mcp' },
      });

      expect(readServer('byCommand')?.transport).toBe('stdio');
      expect(readServer('byUrl')?.transport).toBe('http');
    });

    it('незнакомое значение не утекает в модель — берётся та же догадка', () => {
      // Раньше сюда прошло бы 'websocket' простым приведением типа, и ошибка
      // всплыла бы уже при подключении, где объяснить её нечем.
      writeConfig({
        odd: { type: 'websocket', url: 'https://example.test/mcp' },
        oddLocal: { type: 'grpc', command: 'npx' },
      });

      expect(readServer('odd')?.transport).toBe('http');
      expect(readServer('oddLocal')?.transport).toBe('stdio');
    });
  });

  describe('дубли имён между секциями', () => {
    it('имя есть и в active, и в disabled — активная запись побеждает, id не двоится', () => {
      // Файл правят руками: одно имя может оказаться в обеих секциях. Тогда
      // должна остаться ровно одна запись (включённая), иначе find/toggle
      // получили бы два McpServer с одинаковым id.
      writeFileSync(
        configPath,
        JSON.stringify({
          mcpServers: { dup: { type: 'http', url: 'https://active.test/mcp' } },
          mcpServersDisabled: { dup: { type: 'stdio', command: 'npx' } },
        }),
      );

      const all = readMcpServers(configPath, store).filter((server) => server.id === 'dup');

      expect(all).toHaveLength(1);
      expect(all[0]?.isEnabled).toBe(true);
      expect(all[0]?.transport).toBe('http');
      expect(all[0]?.url).toBe('https://active.test/mcp');
    });

    it('разные имена в обеих секциях остаются обе', () => {
      writeFileSync(
        configPath,
        JSON.stringify({
          mcpServers: { on: { type: 'http', url: 'https://a.test/mcp' } },
          mcpServersDisabled: { off: { type: 'stdio', command: 'npx' } },
        }),
      );

      const servers = readMcpServers(configPath, store);
      expect(servers.find((s) => s.id === 'on')?.isEnabled).toBe(true);
      expect(servers.find((s) => s.id === 'off')?.isEnabled).toBe(false);
    });
  });

  describe('заголовки', () => {
    it('читаются из конфига', () => {
      writeConfig({
        api: {
          type: 'http',
          url: 'https://example.test/mcp',
          headers: { Authorization: 'Bearer x' },
        },
      });

      expect(readServer('api')?.headers).toEqual({ Authorization: 'Bearer x' });
    });

    it('сохраняются и переживают чтение обратно', () => {
      saveMcpServer(configPath, null, {
        name: 'api',
        transport: 'http',
        args: [],
        url: 'https://example.test/mcp',
        env: {},
        headers: { Authorization: 'Bearer x' },
        groupIds: [],
      });

      const raw = JSON.parse(readFileSync(configPath, 'utf8')) as {
        mcpServers: Record<string, { headers?: Record<string, string> } | undefined>;
      };
      expect(raw.mcpServers.api?.headers).toEqual({ Authorization: 'Bearer x' });
      expect(readServer('api')?.headers).toEqual({ Authorization: 'Bearer x' });
    });

    it('пустые заголовки в файл не пишутся — конфиг чужой, мусорить в нём нельзя', () => {
      saveMcpServer(configPath, null, {
        name: 'plain',
        transport: 'stdio',
        command: 'npx',
        args: [],
        env: {},
        headers: {},
        groupIds: [],
      });

      const raw = JSON.parse(readFileSync(configPath, 'utf8')) as {
        mcpServers: Record<string, Record<string, unknown>>;
      };
      expect(raw.mcpServers.plain).not.toHaveProperty('headers');
    });
  });
});
