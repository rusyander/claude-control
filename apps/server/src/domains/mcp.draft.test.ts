import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { McpServerDraft } from '@claude-control/contracts';
import { AppStore } from '../lib/app-store.ts';
import {
  assertMcpDraft,
  assertMcpServerExists,
  deleteMcpServer,
  InvalidMcpDraftError,
  McpServerNotFoundError,
  readMcpServers,
  saveMcpServer,
  setMcpServerEnabled,
} from './mcp.ts';

/**
 * Аудит 2026-09-02: до этого домен записывал в ~/.claude.json всё, что не упало
 * пятисоткой — сервер без транспорта, stdio без команды, адрес «not a url», —
 * а Claude Code такую запись потом молча пропускал. Правка и удаление
 * несуществующего сервера отвечали «ok», правка стирала чужие ключи записи, а
 * итог проверки связи жил только в браузере.
 */
describe('mcp: черновик, 404 и чужие ключи', () => {
  let dir: string;
  let configPath: string;
  let store: AppStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-mcp-draft-'));
    configPath = join(dir, 'claude.json');

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

  const readConfig = (): Record<string, Record<string, Record<string, unknown>>> =>
    JSON.parse(readFileSync(configPath, 'utf8')) as Record<
      string,
      Record<string, Record<string, unknown>>
    >;

  const stdio = (over: Partial<McpServerDraft> = {}): McpServerDraft => ({
    name: 'fixture',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@scope/server'],
    env: {},
    headers: {},
    groupIds: [],
    ...over,
  });

  describe('assertMcpDraft', () => {
    it('минимальное тело без транспорта — отказ словами, а не падение', () => {
      expect(() => assertMcpDraft({ name: 'x' })).toThrow(InvalidMcpDraftError);
      expect(() => assertMcpDraft({ name: 'x' })).toThrow(/Транспорт/);
    });

    it('имя: пустое, с пробелом, с косой чертой и с двойным подчёркиванием — отказ', () => {
      for (const name of ['', '   ', 'my server', 'a/b', 'a\\b', 'gitlab__tools']) {
        expect(() => assertMcpDraft(stdio({ name })), JSON.stringify(name)).toThrow(
          InvalidMcpDraftError,
        );
      }
    });

    it('старое имя, не проходящее правило, при правке под тем же именем не отклоняется', () => {
      for (const name of ['gitlab__tools', 'my server']) {
        expect(() => assertMcpDraft(stdio({ name }), { currentName: name }), name).not.toThrow();
      }
      // Переименование — уже новое имя, правило действует.
      expect(() =>
        assertMcpDraft(stdio({ name: 'a b' }), { currentName: 'gitlab__tools' }),
      ).toThrow(InvalidMcpDraftError);
      // Создание под таким именем по-прежнему отказ.
      expect(() => assertMcpDraft(stdio({ name: 'gitlab__tools' }))).toThrow(InvalidMcpDraftError);
    });

    it('saveMcpServer правит сервер «gitlab__tools» из старого конфига без переименования', () => {
      writeFileSync(
        configPath,
        JSON.stringify({ mcpServers: { gitlab__tools: { command: 'old' } } }),
      );
      expect(() =>
        saveMcpServer(
          configPath,
          'gitlab__tools',
          stdio({ name: 'gitlab__tools', command: 'new' }),
        ),
      ).not.toThrow();
      expect(readConfig().mcpServers?.gitlab__tools?.command).toBe('new');
    });

    it('stdio без команды и сетевой без адреса — отказ', () => {
      expect(() => assertMcpDraft(stdio({ command: '' }))).toThrow(/команда/);
      expect(() => assertMcpDraft(stdio({ command: undefined }))).toThrow(InvalidMcpDraftError);
      expect(() =>
        assertMcpDraft({ name: 'r', transport: 'http', args: [], env: {}, headers: {} }),
      ).toThrow(/адрес/);
    });

    it('сетевой адрес обязан разбираться как http(s); адрес со ссылкой ${VAR} проходит', () => {
      const http = (url: string) => () =>
        assertMcpDraft({ name: 'r', transport: 'http', url, args: [], env: {}, headers: {} });
      expect(http('not a url')).toThrow(/URL/);
      expect(http('ftp://example.test')).toThrow(/URL/);
      expect(http('https://example.test/mcp')).not.toThrow();
      expect(http('${MCP_BASE}/mcp')).not.toThrow();
    });

    it('args/env/headers чужой формы — отказ; отсутствие — нормализуется в пустые', () => {
      expect(() => assertMcpDraft(stdio({ args: 'x' as unknown as string[] }))).toThrow(/args/);
      expect(() => assertMcpDraft(stdio({ env: { 'BAD KEY': '1' } }))).toThrow(/env/);
      expect(() => assertMcpDraft(stdio({ env: { OK: 1 as unknown as string } }))).toThrow(/env/);
      expect(() =>
        assertMcpDraft({
          name: 'r',
          transport: 'http',
          url: 'https://x.test',
          headers: { 'Bad Header': 'v' },
        }),
      ).toThrow(/headers/);

      const minimal: unknown = { name: '  fixture  ', transport: 'stdio', command: ' npx ' };
      assertMcpDraft(minimal);
      expect(minimal).toEqual({
        name: 'fixture',
        transport: 'stdio',
        command: 'npx',
        args: [],
        env: {},
        headers: {},
        groupIds: [],
      });
    });

    it('saveMcpServer сам проверяет черновик — сюда ведут и проектный .mcp.json, и перенос', () => {
      expect(() =>
        saveMcpServer(configPath, null, { name: 'x' } as unknown as McpServerDraft),
      ).toThrow(InvalidMcpDraftError);
    });
  });

  describe('нет такого сервера — McpServerNotFoundError, файл не тронут', () => {
    beforeEach(() => {
      writeFileSync(
        configPath,
        JSON.stringify({ mcpServers: { keep: { type: 'stdio', command: 'x' } } }, null, 2),
      );
    });

    it('правка (PUT) несуществующего — отказ, а не создание под видом правки', () => {
      const before = readFileSync(configPath, 'utf8');
      expect(() => saveMcpServer(configPath, 'ghost', stdio({ name: 'ghost' }))).toThrow(
        McpServerNotFoundError,
      );
      expect(readFileSync(configPath, 'utf8')).toBe(before);
    });

    it('удаление и переключение несуществующего — отказ', () => {
      const before = readFileSync(configPath, 'utf8');
      expect(() => deleteMcpServer(configPath, 'ghost')).toThrow(McpServerNotFoundError);
      expect(() => setMcpServerEnabled(configPath, 'ghost', false)).toThrow(McpServerNotFoundError);
      expect(() => assertMcpServerExists(configPath, 'ghost')).toThrow(McpServerNotFoundError);
      expect(readFileSync(configPath, 'utf8')).toBe(before);
    });

    it('переключение в состояние, где сервер уже есть, — не ошибка и не запись', () => {
      const before = readFileSync(configPath, 'utf8');
      expect(setMcpServerEnabled(configPath, 'keep', true)).toBeUndefined();
      expect(readFileSync(configPath, 'utf8')).toBe(before);
      expect(() => assertMcpServerExists(configPath, 'keep')).not.toThrow();
    });

    it('у ошибок есть statusCode и code — маршрут без своего перехвата всё равно ответит 404', () => {
      const error = new McpServerNotFoundError('ghost');
      expect(error.statusCode).toBe(404);
      expect(error.code).toBe('not_found');
      expect(new InvalidMcpDraftError('x').statusCode).toBe(400);
    });
  });

  describe('чужие ключи записи', () => {
    it('правка переносит неизвестные панели ключи как есть', () => {
      writeFileSync(
        configPath,
        JSON.stringify(
          {
            mcpServers: {
              fixture: {
                type: 'stdio',
                command: 'npx',
                args: ['old'],
                disabled: false,
                alwaysAllow: ['read_file'],
                timeout: 90,
              },
            },
          },
          null,
          2,
        ),
      );

      saveMcpServer(configPath, 'fixture', stdio({ args: ['new'] }));

      const record = readConfig().mcpServers?.fixture ?? {};
      expect(record.args).toEqual(['new']);
      expect(record.disabled).toBe(false);
      expect(record.alwaysAllow).toEqual(['read_file']);
      expect(record.timeout).toBe(90);
    });

    it('переименование уносит чужие ключи вместе с записью', () => {
      writeFileSync(
        configPath,
        JSON.stringify({ mcpServers: { old: { type: 'stdio', command: 'x', foo: 'bar' } } }),
      );
      saveMcpServer(configPath, 'old', stdio({ name: 'new', command: 'x' }));

      const servers = readConfig().mcpServers ?? {};
      expect(servers.old).toBeUndefined();
      expect(servers.new?.foo).toBe('bar');
    });
  });

  describe('итог проверки связи из состояния панели', () => {
    it('readMcpServers подмешивает сохранённый итог только включённому серверу', () => {
      writeFileSync(
        configPath,
        JSON.stringify({
          mcpServers: { live: { type: 'http', url: 'https://x.test' } },
          mcpServersDisabled: { off: { type: 'http', url: 'https://y.test' } },
        }),
      );
      store.saveMcpHealth('live', {
        health: 'connected',
        toolCount: 7,
        checkedAt: '2026-09-02T10:00:00.000Z',
      });
      store.saveMcpHealth('off', {
        health: 'failed',
        detail: 'x',
        checkedAt: '2026-09-02T10:00:00.000Z',
      });

      const byId = Object.fromEntries(readMcpServers(configPath, store).map((s) => [s.id, s]));
      expect(byId.live).toMatchObject({
        health: 'connected',
        toolCount: 7,
        checkedAt: '2026-09-02T10:00:00.000Z',
      });
      // Выключенный — всегда disabled: старый итог не должен выглядеть свежим.
      expect(byId.off?.health).toBe('disabled');
      expect(byId.off?.checkedAt).toBeUndefined();
    });

    it('переименование и удаление сущности переносят/забывают итог', () => {
      store.saveMcpHealth('a', { health: 'connected', checkedAt: '2026-09-02T10:00:00.000Z' });
      store.renameEntity('mcp', 'a', 'b');
      expect(store.getMcpHealth().a).toBeUndefined();
      expect(store.getMcpHealth().b?.health).toBe('connected');

      store.removeEntity('mcp', 'b');
      expect(store.getMcpHealth()).toEqual({});
    });
  });

  // Аудит «Группы» 2026-09-03: после «выключить → включить» в ~/.claude.json
  // оставался наш ключ `"mcpServersDisabled": {}` — файл, который правит сам
  // Claude Code, не возвращался к прежнему виду.
  describe('секция отключённых не остаётся пустой', () => {
    const original = { mcpServers: { a: { type: 'stdio', command: 'npx' } }, numStartups: 3 };

    it('выключить → включить возвращает объект к исходному без mcpServersDisabled', () => {
      writeFileSync(configPath, JSON.stringify(original));
      setMcpServerEnabled(configPath, 'a', false);
      expect(readConfig().mcpServersDisabled).toHaveProperty('a');
      setMcpServerEnabled(configPath, 'a', true);
      expect(readConfig()).toEqual(original);
    });

    it('удаление последнего отключённого убирает пустую секцию', () => {
      writeFileSync(
        configPath,
        JSON.stringify({
          mcpServers: {},
          mcpServersDisabled: { a: { type: 'stdio', command: 'npx' } },
        }),
      );
      deleteMcpServer(configPath, 'a');
      expect(readConfig()).toEqual({ mcpServers: {} });
    });
  });
});
