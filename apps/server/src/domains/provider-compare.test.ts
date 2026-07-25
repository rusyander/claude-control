import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { EnvVar, McpServer, PermissionRule } from '@claude-control/contracts';
import { removeEntry } from '../lib/safe-io.ts';
import {
  compareProviders,
  migrateProvider,
  CompareRequestError,
  type ClaudeSide,
} from './provider-compare.ts';

/**
 * Сравнение и перенос. Доказываем: разница считается по СМЫСЛУ (один и тот же
 * сервер в JSON и TOML — «одинаково»), секреты не сравниваются по значению,
 * предпросмотр переноса настоящий файл не трогает, а то, что панель переносить не
 * умеет, отвергается вслух, а не переносится наугад.
 */

const CODEX_CONFIG = `approval_policy = "on-request"

[mcp_servers.shared]
command = "npx"
args = ["shared-server"]

[mcp_servers.codex-only]
command = "node"
args = ["own.js"]
`;

function claudeServer(over: Partial<McpServer> = {}): McpServer {
  return {
    id: 'shared',
    name: 'shared',
    transport: 'stdio',
    command: 'npx',
    args: ['shared-server'],
    url: undefined,
    env: {},
    headers: {},
    health: 'unknown',
    isEnabled: true,
    groupIds: [],
    hasOAuth: false,
    ...over,
  };
}

describe('compareProviders / migrateProvider', () => {
  let home: string;
  let previousCodex: string | undefined;
  let claudeMd: string;
  let written: { path: string; name: string }[];

  const claudeSide = (over: Partial<ClaudeSide> = {}): ClaudeSide => ({
    mcpConfigPath: join(home, 'claude.json'),
    claudeMdPath: claudeMd,
    readMcp: () => [claudeServer(), claudeServer({ id: 'claude-only', name: 'claude-only' })],
    readEnv: (): EnvVar[] => [
      { id: 'settings:PATHY', key: 'PATHY', value: '/tmp', isSecret: false, source: 'settings' },
      {
        id: 'settings:API_KEY',
        key: 'API_KEY',
        value: 'sk-•••',
        isSecret: true,
        source: 'settings',
      },
    ],
    readPermissions: (): PermissionRule[] => [
      { id: '1', pattern: 'Bash(git push:*)', decision: 'ask', groupIds: [], source: 'settings' },
    ],
    writeMcp: (path, server) => {
      written.push({ path, name: server.name });
      writeFileSync(path, JSON.stringify({ mcpServers: { [server.name]: {} } }));
    },
    ...over,
  });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cc-compare-test-'));
    previousCodex = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    writeFileSync(join(home, 'config.toml'), CODEX_CONFIG);
    writeFileSync(join(home, 'AGENTS.md'), 'старый текст codex\n');
    claudeMd = join(home, 'CLAUDE.md');
    writeFileSync(claudeMd, 'правила claude\n');
    written = [];
  });

  afterEach(() => {
    if (previousCodex === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodex;
    removeEntry(home);
  });

  it('MCP: одинаковый сервер в разных форматах считается одинаковым', () => {
    const result = compareProviders('claude', 'codex', { claude: claudeSide() });
    const mcp = result.sections.find((section) => section.section === 'mcp');

    expect(mcp?.migratable).toBe(true);
    const byKey = new Map(mcp?.entries.map((entry) => [entry.key, entry]));
    expect(byKey.get('shared')?.state).toBe('same');
    expect(byKey.get('claude-only')?.state).toBe('left-only');
    expect(byKey.get('codex-only')?.state).toBe('right-only');
  });

  it('секрет сверяется только по наличию и не переносится', () => {
    const result = compareProviders('claude', 'codex', { claude: claudeSide() });
    const env = result.sections.find((section) => section.section === 'env');

    expect(env?.migratable).toBe(false);
    const secret = env?.entries.find((entry) => entry.key === 'API_KEY');
    expect(secret?.opaque).toBe(true);
    expect(secret?.state).toBe('left-only');
  });

  it('права показываются рядом, но помечены как несравнимые', () => {
    const result = compareProviders('claude', 'codex', { claude: claudeSide() });
    const permissions = result.sections.find((section) => section.section === 'permissions');

    expect(permissions?.comparable).toBe(false);
    expect(permissions?.migratable).toBe(false);
    expect(permissions?.entries.length).toBeGreaterThan(0);
  });

  it('инструкции сравниваются по содержимому, а не по имени файла', () => {
    const result = compareProviders('claude', 'codex', { claude: claudeSide() });
    const instructions = result.sections.find((section) => section.section === 'instructions');
    const entry = instructions?.entries[0];

    expect(entry?.state).toBe('differs');
    expect(entry?.left).toContain('CLAUDE.md');
    expect(entry?.right).toContain('AGENTS.md');
  });

  it('предпросмотр переноса MCP не трогает настоящий файл', () => {
    const before = readFileSync(join(home, 'config.toml'), 'utf8');
    const result = migrateProvider(
      { from: 'claude', to: 'codex', section: 'mcp', keys: ['claude-only'], mode: 'preview' },
      { claude: claudeSide() },
    );

    expect(result.applied).toEqual(['claude-only']);
    expect(result.diff?.added).toBeGreaterThan(0);
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe(before);
  });

  it('перенос MCP пишет сервер в файл приёмника', () => {
    migrateProvider(
      { from: 'claude', to: 'codex', section: 'mcp', keys: ['claude-only'], mode: 'apply' },
      { claude: claudeSide() },
    );

    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toContain('[mcp_servers.claude-only]');
  });

  it('выключенный сервер и транспорт sse не переносятся молча', () => {
    const side = claudeSide({
      readMcp: () => [
        claudeServer({ id: 'off', name: 'off', isEnabled: false }),
        claudeServer({ id: 'legacy', name: 'legacy', transport: 'sse', url: 'https://x' }),
      ],
    });

    const result = migrateProvider(
      {
        from: 'claude',
        to: 'codex',
        section: 'mcp',
        keys: ['off', 'legacy', 'нет'],
        mode: 'apply',
      },
      { claude: side },
    );

    expect(result.applied).toEqual([]);
    expect(result.skipped.map((item) => item.key).sort()).toEqual(['legacy', 'off', 'нет']);
  });

  it('перенос инструкций перезаписывает файл приёмника', () => {
    migrateProvider(
      { from: 'claude', to: 'codex', section: 'instructions', mode: 'apply' },
      { claude: claudeSide() },
    );

    expect(readFileSync(join(home, 'AGENTS.md'), 'utf8')).toBe('правила claude\n');
  });

  it('в сторону Claude перенос идёт его собственным писателем', () => {
    const side = claudeSide();
    migrateProvider(
      { from: 'codex', to: 'claude', section: 'mcp', keys: ['codex-only'], mode: 'apply' },
      { claude: side },
    );

    expect(written).toEqual([{ path: join(home, 'claude.json'), name: 'codex-only' }]);
  });

  it('переменные и права переносить отказываемся вслух', () => {
    for (const section of ['env', 'permissions'] as const) {
      expect(() =>
        migrateProvider(
          { from: 'claude', to: 'codex', section, mode: 'apply' },
          {
            claude: claudeSide(),
          },
        ),
      ).toThrow(CompareRequestError);
    }
  });

  it('провайдер сам с собой не сравнивается', () => {
    expect(() => compareProviders('codex', 'codex', { claude: claudeSide() })).toThrow(
      CompareRequestError,
    );
    expect(existsSync(join(home, 'config.toml'))).toBe(true);
  });
});
