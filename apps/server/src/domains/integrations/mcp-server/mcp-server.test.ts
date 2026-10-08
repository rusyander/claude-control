import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseToml } from 'smol-toml';
import {
  ATLASSIAN_MCP_ID,
  atlassianMcpScript,
  isAtlassianMcpRegistered,
  registerAtlassianMcp,
  unregisterAtlassianMcp,
} from './mcp-server.ts';

/**
 * Регистрация переходника у ЛЮБОГО из десяти CLI.
 *
 * Проверяется не «умеет ли codex toml» — это дело `provider-mcp.test.ts`, — а то,
 * что кнопка одна и пишет она в конфиг АКТИВНОГО провайдера: у Claude свой файл,
 * у остальных — их собственный, а провайдер без MCP не получает записи вовсе.
 *
 * Второй инвариант, ради которого этот файл и существует: в записи нет токена
 * Atlassian ни у одного провайдера. Переходник ходит в панель, к Atlassian ходит
 * уже она.
 */

function fakeStore(provider: string, claudeDirOverride = '') {
  return { getSettings: () => ({ provider, claudeDirOverride }) };
}

interface ParsedToml {
  mcp_servers: Record<string, Record<string, unknown>>;
  model?: string;
}

describe('регистрация переходника у активного провайдера', () => {
  let root: string;
  let claudeJson: string;
  let codexHome: string;
  const previousCodexHome = process.env.CODEX_HOME;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-mcp-reg-'));
    claudeJson = join(root, '.claude.json');
    codexHome = join(root, 'codex');
    mkdirSync(codexHome, { recursive: true });
    // Документированная переменная самого codex — тестам не нужно трогать HOME.
    process.env.CODEX_HOME = codexHome;
  });

  afterEach(() => {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    rmSync(root, { recursive: true, force: true });
  });

  const options = (provider?: string) => ({
    mcpConfigPath: claudeJson,
    backupDir: join(root, 'backups'),
    selfBaseUrl: 'http://127.0.0.1:5178',
    store: provider ? fakeStore(provider) : undefined,
  });

  it('codex: запись уходит в его config.toml, а не в конфиг Claude', () => {
    const name = registerAtlassianMcp(options('codex'));
    expect(name).toBe(ATLASSIAN_MCP_ID);

    const parsed = parseToml(
      readFileSync(join(codexHome, 'config.toml'), 'utf8'),
    ) as unknown as ParsedToml;
    expect(parsed.mcp_servers[ATLASSIAN_MCP_ID]).toMatchObject({
      command: process.execPath,
      args: [atlassianMcpScript()],
      env: { AGENTDECK_URL: 'http://127.0.0.1:5178' },
    });
    // Чужой файл не тронут: у Claude свои роуты, и молча писать туда нельзя.
    expect(existsSync(claudeJson)).toBe(false);
  });

  it('codex: чужие ключи конфига переживают регистрацию', () => {
    writeFileSync(
      join(codexHome, 'config.toml'),
      '# codex\nmodel = "gpt-5"\n\n[mcp_servers.existing]\ncommand = "node"\n',
      'utf8',
    );

    registerAtlassianMcp(options('codex'));
    const text = readFileSync(join(codexHome, 'config.toml'), 'utf8');
    expect(text).toContain('# codex');
    const parsed = parseToml(text) as unknown as ParsedToml;
    expect(parsed.model).toBe('gpt-5');
    expect(Object.keys(parsed.mcp_servers).sort()).toEqual([ATLASSIAN_MCP_ID, 'existing'].sort());
  });

  it('повторная кнопка обновляет запись, а не отказывает 409', () => {
    registerAtlassianMcp(options('codex'));
    expect(() =>
      registerAtlassianMcp({ ...options('codex'), selfBaseUrl: 'http://127.0.0.1:6000' }),
    ).not.toThrow();

    const parsed = parseToml(
      readFileSync(join(codexHome, 'config.toml'), 'utf8'),
    ) as unknown as ParsedToml;
    expect(Object.keys(parsed.mcp_servers)).toEqual([ATLASSIAN_MCP_ID]);
    expect(parsed.mcp_servers[ATLASSIAN_MCP_ID]!.env).toEqual({
      AGENTDECK_URL: 'http://127.0.0.1:6000',
    });
  });

  it('кнопка «подключено» спрашивает тот же файл, в который пишет', () => {
    expect(isAtlassianMcpRegistered(claudeJson, fakeStore('codex'))).toBe(false);
    registerAtlassianMcp(options('codex'));
    expect(isAtlassianMcpRegistered(claudeJson, fakeStore('codex'))).toBe(true);
    // Ответ про codex не должен зависеть от того, что лежит у Claude.
    expect(isAtlassianMcpRegistered(claudeJson, fakeStore('claude'))).toBe(false);
  });

  it('снятие: сначала true, повторное — false, ошибки нет', () => {
    registerAtlassianMcp(options('codex'));
    expect(unregisterAtlassianMcp(options('codex'))).toBe(true);
    expect(unregisterAtlassianMcp(options('codex'))).toBe(false);
    expect(isAtlassianMcpRegistered(claudeJson, fakeStore('codex'))).toBe(false);
  });

  it('claude и провайдер без MCP (aider) пишут в конфиг Claude', () => {
    writeFileSync(claudeJson, JSON.stringify({ mcpServers: {} }), 'utf8');
    registerAtlassianMcp(options('claude'));
    expect(isAtlassianMcpRegistered(claudeJson)).toBe(true);

    expect(unregisterAtlassianMcp(options('aider'))).toBe(true);
    expect(isAtlassianMcpRegistered(claudeJson)).toBe(false);
  });

  it('в записи нет токена Atlassian ни у одного провайдера', () => {
    registerAtlassianMcp(options('codex'));
    writeFileSync(claudeJson, JSON.stringify({ mcpServers: {} }), 'utf8');
    registerAtlassianMcp(options('claude'));

    const written = [
      readFileSync(join(codexHome, 'config.toml'), 'utf8'),
      readFileSync(claudeJson, 'utf8'),
    ].join('\n');
    expect(written).not.toMatch(/token|password|api[_-]?key|Basic |Bearer /i);
    expect(written).toContain('AGENTDECK_URL');
  });
});
