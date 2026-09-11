import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseToml } from 'smol-toml';
import {
  PLATFORM_MCP_ID,
  isPlatformMcpRegistered,
  platformMcpRefusal,
  platformMcpScript,
  registerPlatformMcp,
  unregisterPlatformMcp,
} from './mcp-bridge.ts';

/**
 * Переходник к контуру в конфигурации ЛЮБОГО из десяти CLI.
 *
 * Главное здесь — второй инвариант партии: ключа контура нет ни в одной
 * записи. Переходник ходит в панель, а в контур ходит уже она, поэтому в
 * окружение процесса уезжает ровно один адрес.
 */

function fakeStore(provider: string, claudeDirOverride = '') {
  return { getSettings: () => ({ provider, claudeDirOverride }) };
}

interface ParsedToml {
  mcp_servers: Record<string, Record<string, unknown>>;
}

describe('переходник контура', () => {
  let root: string;
  let claudeJson: string;
  let codexHome: string;
  const previousCodexHome = process.env.CODEX_HOME;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-platform-mcp-'));
    claudeJson = join(root, '.claude.json');
    codexHome = join(root, 'codex');
    mkdirSync(codexHome, { recursive: true });
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

  it('скрипт переходника лежит в репозитории панели', () => {
    expect(existsSync(platformMcpScript())).toBe(true);
  });

  it('имя записи не совпадает с вероятным именем чужого сервера', () => {
    // «contour» и «enterprise-platform» — как раз те имена, которыми человек назвал бы
    // СВОЙ сервер: совпадение означало бы запись поверх чужой настройки.
    expect(PLATFORM_MCP_ID).toBe('agentdeck-contour');
  });

  it('codex: запись уходит в его config.toml с одним лишь адресом панели', () => {
    expect(registerPlatformMcp(options('codex'))).toBe(PLATFORM_MCP_ID);

    const parsed = parseToml(
      readFileSync(join(codexHome, 'config.toml'), 'utf8'),
    ) as unknown as ParsedToml;
    expect(parsed.mcp_servers[PLATFORM_MCP_ID]).toMatchObject({
      env: { AGENTDECK_URL: 'http://127.0.0.1:5178' },
    });
  });

  it('кнопка «подключено» спрашивает тот же файл, в который пишет', () => {
    expect(isPlatformMcpRegistered(claudeJson, fakeStore('codex'))).toBe(false);
    registerPlatformMcp(options('codex'));
    expect(isPlatformMcpRegistered(claudeJson, fakeStore('codex'))).toBe(true);
    expect(isPlatformMcpRegistered(claudeJson, fakeStore('claude'))).toBe(false);
  });

  it('снятие: сначала true, повторное — false, ошибки нет', () => {
    registerPlatformMcp(options('codex'));
    expect(unregisterPlatformMcp(options('codex'))).toBe(true);
    expect(unregisterPlatformMcp(options('codex'))).toBe(false);
  });

  it('переходник контура и переходник Atlassian живут рядом, не затирая друг друга', () => {
    writeFileSync(claudeJson, JSON.stringify({ mcpServers: {} }), 'utf8');
    registerPlatformMcp(options('claude'));

    const config = JSON.parse(readFileSync(claudeJson, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(config.mcpServers)).toContain(PLATFORM_MCP_ID);
    expect(Object.keys(config.mcpServers)).not.toContain('agentdeck-atlassian');
  });

  it('CLI без раздела MCP: отказ с причиной, а не запись в чужой файл', () => {
    // Развилка тут обратная очевидной: `resolveProviderMcpTarget` молчит и у
    // Claude (его запасной путь `~/.claude.json` — ПРАВИЛЬНЫЙ), и у провайдера
    // без MCP вовсе. Без этой проверки второй сваливался в тот же запасной
    // путь: панель писала в конфигурацию Claude Code и рапортовала успех, а у
    // человека в его CLI инструмента не появлялось.
    expect(platformMcpRefusal(fakeStore('aider'))).toContain('MCP');
    expect(() => registerPlatformMcp(options('aider'))).toThrow(/MCP/);
    expect(existsSync(claudeJson)).toBe(false);
  });

  it('Claude и провайдеры с MCP причины отказа не имеют', () => {
    expect(platformMcpRefusal(fakeStore('claude'))).toBeUndefined();
    expect(platformMcpRefusal(fakeStore('codex'))).toBeUndefined();
    // Настроек нет вовсе — работаем как до универсальных провайдеров.
    expect(platformMcpRefusal(undefined)).toBeUndefined();
  });

  it('в записи нет ключа контура ни у одного провайдера', () => {
    registerPlatformMcp(options('codex'));
    writeFileSync(claudeJson, JSON.stringify({ mcpServers: {} }), 'utf8');
    registerPlatformMcp(options('claude'));

    const written = [
      readFileSync(join(codexHome, 'config.toml'), 'utf8'),
      readFileSync(claudeJson, 'utf8'),
    ].join('\n');
    expect(written).not.toMatch(/token|password|api[_-]?key|Basic |Bearer /i);
    expect(written).toContain('AGENTDECK_URL');
  });
});
