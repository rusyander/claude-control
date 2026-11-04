import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { codexMcpSource } from '../codex/mcp-source.ts';
import { gooseMcpSource } from '../goose/mcp-source.ts';
import { kimiMcpSource } from '../kimi/mcp-source.ts';
import { opencodeMcpSource } from '../opencode/mcp-source.ts';
import type { McpSourceRead } from './mcp-source.ts';

/**
 * Читатели MCP человека (P73, s10 p7): каждый CLI — своими файлами и в своём порядке (факты —
 * пробы 02.11: `codex mcp list`, `opencode debug config`, исходник Kimi 2.4.1). Дом человека и
 * проект — временные каталоги; доверие проекта — отметка панели или запись самого CLI.
 */

function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function world(prefix: string) {
  const root = tempDir(prefix);
  const home = join(root, 'home');
  const repo = join(root, 'repo');
  const cwd = join(repo, 'sub');
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const pin = { HOME: home, USERPROFILE: home };
  return { root, home, repo, cwd, pin };
}

const trusted = (repo: string) => ({ sourceRepo: repo, panelMark: true });
const byId = (read: McpSourceRead) => Object.fromEntries(read.servers.map((s) => [s.id, s]));

describe('codex mcp source', () => {
  const user = (home: string, extra = '') =>
    put(
      join(home, '.codex', 'config.toml'),
      [
        '[mcp_servers.shared]',
        'command = "user-cmd"',
        'args = ["u"]',
        'env = { SECRET = "user-secret" }',
        '[mcp_servers.useronly]',
        'command = "user-only"',
        'env_vars = ["FROM_PIN", "MISSING"]',
        'cwd = "/srv"',
        '[mcp_servers.off]',
        'command = "x"',
        'enabled = false',
        '[mcp_servers.far]',
        'url = "https://example.invalid/mcp"',
        extra,
      ].join('\n'),
    );

  it('user layer: enabled stdio servers offered, disabled absent, url named, env_vars from the pin', () => {
    const w = world('cx-src-');
    user(w.home);
    const got = codexMcpSource({ pin: { ...w.pin, FROM_PIN: 'pinned' }, cwd: w.cwd });
    const s = byId(got);
    expect(Object.keys(s).sort()).toEqual(['far', 'shared', 'useronly']);
    expect(s.useronly!.entry).toEqual({
      command: 'user-only',
      args: [],
      env: { FROM_PIN: 'pinned' },
      cwd: '/srv',
    });
    expect(s.far!.entry).toEqual({ url: 'https://example.invalid/mcp', transport: 'http' });
    expect(got.projectSkipped).toMatch(/no source repository trust/);
  });

  it('trusted project: layers merge by field, the layer nearest cwd wins; untrusted: project unread', () => {
    const w = world('cx-src-');
    user(w.home);
    put(
      join(w.repo, '.codex', 'config.toml'),
      '[mcp_servers.shared]\ncommand = "proj-cmd"\n[mcp_servers.projonly]\ncommand = "proj-only"\n',
    );
    put(join(w.cwd, '.codex', 'config.toml'), '[mcp_servers.projonly]\nargs = ["from-sub"]\n');
    const untrusted = codexMcpSource({
      pin: w.pin,
      cwd: w.cwd,
      trust: { sourceRepo: w.repo, panelMark: false },
    });
    expect(byId(untrusted).projonly).toBeUndefined();
    expect(byId(untrusted).shared!.entry!.command).toBe('user-cmd');
    expect(untrusted.projectSkipped).toMatch(/not trusted/);

    const got = byId(codexMcpSource({ pin: w.pin, cwd: w.cwd, trust: trusted(w.repo) }));
    // Проект сменил `command`; `args` и `env` пользователя остались (слияние по полям, как у Codex).
    expect(got.shared).toMatchObject({
      scope: 'project',
      entry: { command: 'proj-cmd', args: ['u'], env: { SECRET: 'user-secret' } },
    });
    expect(got.projonly!.entry).toEqual({ command: 'proj-only', args: ['from-sub'] });
    expect(got.projonly!.file).toBe(join(w.cwd, '.codex', 'config.toml'));
  });

  it("codex's own trust record opens the project layer (Windows key with \\, case folded on win32)", () => {
    const w = world('cx-src-');
    const key = process.platform === 'win32' ? w.repo.toUpperCase() : w.repo;
    user(w.home, `[projects.'${key}']\ntrust_level = "trusted"\n`);
    put(join(w.repo, '.codex', 'config.toml'), '[mcp_servers.projonly]\ncommand = "p"\n');
    const got = codexMcpSource({
      pin: w.pin,
      cwd: w.cwd,
      trust: { sourceRepo: w.repo, panelMark: false },
    });
    expect(byId(got).projonly?.scope).toBe('project');
  });

  it('CODEX_HOME moves the user file; a broken file is named, not empty', () => {
    const w = world('cx-src-');
    put(join(w.root, 'ch', 'config.toml'), '[mcp_servers.a\ncommand=');
    const got = codexMcpSource({ pin: { ...w.pin, CODEX_HOME: join(w.root, 'ch') }, cwd: w.cwd });
    expect(got.servers).toEqual([]);
    expect(got.unread[0]!.file).toBe(join(w.root, 'ch', 'config.toml'));
  });
});

describe('goose mcp source', () => {
  it('stdio extensions offered; builtins absent; env_keys and remote named; GOOSE_PATH_ROOT honoured', () => {
    const w = world('gs-src-');
    const rootDir = join(w.root, 'groot');
    put(
      join(rootDir, 'config', 'config.yaml'),
      [
        'extensions:',
        '  atlas:',
        '    enabled: true',
        '    type: stdio',
        '    cmd: atlas-mcp',
        '  developer:',
        '    enabled: true',
        '    type: builtin',
        '    name: developer',
        '  probe:',
        '    enabled: true',
        '    type: stdio',
        '    cmd: node',
        '    args: [probe.mjs]',
        '    envs: { TOKEN: abcdefgh }',
        '  keyed:',
        '    enabled: true',
        '    type: stdio',
        '    cmd: node',
        '    env_keys: [GITHUB_TOKEN]',
        '  far:',
        '    enabled: true',
        '    type: streamable_http',
        '    uri: https://example.invalid/mcp',
        '  off:',
        '    enabled: false',
        '    type: stdio',
        '    cmd: x',
        '',
      ].join('\n'),
    );
    const got = byId(gooseMcpSource({ pin: { ...w.pin, GOOSE_PATH_ROOT: rootDir }, cwd: w.cwd }));
    expect(Object.keys(got).sort()).toEqual(['atlas', 'far', 'keyed', 'probe']);
    expect(got.atlas!.entry).toEqual({ command: 'atlas-mcp', args: [] });
    expect(got.probe!.entry).toEqual({
      command: 'node',
      args: ['probe.mjs'],
      env: { TOKEN: 'abcdefgh' },
    });
    expect(got.keyed!.skipped).toMatch(/secret store/);
    expect(got.far!.entry).toEqual({ url: 'https://example.invalid/mcp', transport: 'http' });
  });
});

describe('opencode mcp source', () => {
  it('global config.json < opencode.json < opencode.jsonc < OPENCODE_CONFIG < project (json < jsonc, then .opencode)', () => {
    const w = world('oc-src-');
    const g = join(w.home, '.config', 'opencode');
    const local = (command: string[], extra: object = {}) => ({ type: 'local', command, ...extra });
    put(join(g, 'config.json'), JSON.stringify({ mcp: { g: local(['a']) } }));
    put(
      join(g, 'opencode.json'),
      JSON.stringify({
        mcp: {
          g: local(['b']),
          shared: local(['user-cmd', 'u'], { environment: { SECRET: 'user-secret' } }),
          off: local(['x'], { enabled: false }),
          far: { type: 'remote', url: 'https://example.invalid/mcp' },
          sub: local(['{env:PROBE_X}', '--k={env:NOPE}']),
          file: local(['n'], { environment: { K: '{file:~/.key}' } }),
        },
      }),
    );
    put(
      join(g, 'opencode.jsonc'),
      '{ // comment\n "mcp": { "g": { "type": "local", "command": ["c"] } } }',
    );
    const custom = join(w.root, 'custom.json');
    put(custom, JSON.stringify({ mcp: { projonly: local(['custom']), cfg: local(['cfg']) } }));
    put(
      join(w.repo, 'opencode.json'),
      JSON.stringify({ mcp: { shared: local(['proj-cmd']), projonly: local(['proj-json']) } }),
    );
    put(
      join(w.repo, 'opencode.jsonc'),
      JSON.stringify({ mcp: { projonly: local(['proj-jsonc']) } }),
    );
    put(
      join(w.repo, '.opencode', 'opencode.json'),
      JSON.stringify({ mcp: { dot: local(['dot']) } }),
    );
    const pin = { ...w.pin, OPENCODE_CONFIG: custom, PROBE_X: 'xval' };

    const got = byId(opencodeMcpSource({ pin, cwd: w.cwd, trust: trusted(w.repo) }));
    expect(got.g!.entry!.command).toBe('c');
    expect(got.cfg!.entry!.command).toBe('cfg');
    expect(got.projonly!.entry!.command).toBe('proj-jsonc');
    expect(got.dot!.scope).toBe('project');
    // Массив `command` заменён проектом, `environment` пользователя остался (слияние вглубь).
    expect(got.shared!.entry).toEqual({
      command: 'proj-cmd',
      args: [],
      env: { SECRET: 'user-secret' },
    });
    expect(got.sub!.entry).toEqual({ command: 'xval', args: ['--k='] });
    expect(got.file!.skipped).toMatch(/\{file:/);
    expect(got.far!.entry).toEqual({ url: 'https://example.invalid/mcp', transport: 'http' });
    expect(got.off).toBeUndefined();

    const untrusted = byId(opencodeMcpSource({ pin, cwd: w.cwd }));
    expect(untrusted.projonly!.entry!.command).toBe('custom');
    expect(untrusted.dot).toBeUndefined();
  });
});

describe('kimi mcp source', () => {
  it('user < project-root .mcp.json < cwd .kimi-code/mcp.json, whole-entry replacement; foreign cwd named', () => {
    const w = world('km-src-');
    const kimiHome = join(w.root, 'kh');
    put(
      join(kimiHome, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          shared: { command: 'user-cmd', args: ['u'], env: { SECRET: 'user-secret' } },
          useronly: { command: 'user-only' },
          off: { command: 'x', enabled: false },
          far: { url: 'https://example.invalid/mcp' },
        },
      }),
    );
    put(
      join(w.repo, '.mcp.json'),
      JSON.stringify({ mcpServers: { shared: { command: 'root-cmd' }, rooted: { command: 'r' } } }),
    );
    put(
      join(w.cwd, '.kimi-code', 'mcp.json'),
      JSON.stringify({
        mcpServers: { localonly: { command: 'l' }, elsewhere: { command: 'e', cwd: '/srv' } },
      }),
    );
    const pin = { ...w.pin, KIMI_CODE_HOME: kimiHome };

    // Каталог сеанса — корень проекта: `cwd` сервера из `.mcp.json` (его каталог) совпадает.
    const atRoot = byId(kimiMcpSource({ pin, cwd: w.repo, trust: trusted(w.repo) }));
    expect(atRoot.shared!.entry).toEqual({ command: 'root-cmd', args: [] });
    expect(atRoot.rooted!.scope).toBe('project');

    const got = byId(kimiMcpSource({ pin, cwd: w.cwd, trust: trusted(w.repo) }));
    expect(got.localonly!.entry).toEqual({ command: 'l', args: [] });
    expect(got.elsewhere!.skipped).toMatch(/ACP carries no cwd/);
    // Из подкаталога сервер `.mcp.json` запустился бы в корне — ACP этого не несёт: назван.
    expect(got.rooted!.skipped).toMatch(/ACP carries no cwd/);
    expect(got.far!.entry).toEqual({ url: 'https://example.invalid/mcp', transport: 'http' });
    expect(got.off).toBeUndefined();

    const untrusted = byId(kimiMcpSource({ pin, cwd: w.repo }));
    expect(untrusted.shared!.entry).toEqual({
      command: 'user-cmd',
      args: ['u'],
      env: { SECRET: 'user-secret' },
    });
    expect(untrusted.rooted).toBeUndefined();
  });
});

describe('remote human servers: url + headers in each CLI form (s10 p8)', () => {
  const URL_ = 'https://mcp.example.com/mcp';
  const pin = (w: ReturnType<typeof world>) => ({ ...w.pin, TOK: 'tok-123456', ORG: 'org-9' });

  it('codex: http_headers as is, env_http_headers and bearer_token_env_var from the pin; unset var named', () => {
    const w = world('cx-remote-');
    put(
      join(w.home, '.codex', 'config.toml'),
      [
        '[mcp_servers.web]',
        `url = "${URL_}"`,
        'bearer_token_env_var = "TOK"',
        'http_headers = { "X-Region" = "eu" }',
        'env_http_headers = { "X-Org" = "ORG" }',
        '[mcp_servers.nokey]',
        `url = "${URL_}"`,
        'bearer_token_env_var = "NOPE"',
        '',
      ].join('\n'),
    );
    const got = byId(codexMcpSource({ pin: pin(w), cwd: w.cwd }));
    expect(got.web!.entry).toEqual({
      url: URL_,
      transport: 'http',
      headers: { 'X-Region': 'eu', 'X-Org': 'org-9', Authorization: 'Bearer tok-123456' },
    });
    expect(got.nokey!.skipped).toMatch(/env var NOPE unset/);
  });

  it('goose: streamable_http uri + headers carried; sse refused by goose itself, named; non-http uri named', () => {
    const w = world('gs-remote-');
    const rootDir = join(w.root, 'groot');
    put(
      join(rootDir, 'config', 'config.yaml'),
      [
        'extensions:',
        '  web: { enabled: true, type: streamable_http, uri: "' +
          URL_ +
          '", headers: { X-Key: abcdefgh } }',
        '  old: { enabled: true, type: sse, uri: "https://old.example.com/sse" }',
        '  bad: { enabled: true, type: streamable_http, uri: "ftp://x" }',
        '',
      ].join('\n'),
    );
    const got = byId(gooseMcpSource({ pin: { ...w.pin, GOOSE_PATH_ROOT: rootDir }, cwd: w.cwd }));
    expect(got.web!.entry).toEqual({
      url: URL_,
      transport: 'http',
      headers: { 'X-Key': 'abcdefgh' },
    });
    expect(got.old!.skipped).toMatch(/refuses sse/);
    expect(got.bad!.skipped).toMatch(/without an http\(s\) url/);
  });

  it('opencode: type remote url + headers with {env:X} from the pin; oauth object named', () => {
    const w = world('oc-remote-');
    put(
      join(w.home, '.config', 'opencode', 'opencode.json'),
      JSON.stringify({
        mcp: {
          web: { type: 'remote', url: URL_, headers: { Authorization: 'Bearer {env:TOK}' } },
          auth: { type: 'remote', url: URL_, oauth: { clientId: 'c' } },
        },
      }),
    );
    const got = byId(opencodeMcpSource({ pin: pin(w), cwd: w.cwd }));
    expect(got.web!.entry).toEqual({
      url: URL_,
      transport: 'http',
      headers: { Authorization: 'Bearer tok-123456' },
    });
    expect(got.auth!.skipped).toMatch(/oauth/);
  });

  it('kimi: http and sse keep their transport, bearerTokenEnvVar → Authorization; auth oauth named', () => {
    const w = world('km-remote-');
    const kimiHome = join(w.root, 'kh');
    put(
      join(kimiHome, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          web: { url: URL_, headers: { 'X-Org': 'o' }, bearerTokenEnvVar: 'TOK' },
          old: { transport: 'sse', url: 'https://old.example.com/sse' },
          auth: { url: URL_, auth: 'oauth' },
        },
      }),
    );
    const got = byId(kimiMcpSource({ pin: { ...pin(w), KIMI_CODE_HOME: kimiHome }, cwd: w.cwd }));
    expect(got.web!.entry).toEqual({
      url: URL_,
      transport: 'http',
      headers: { 'X-Org': 'o', Authorization: 'Bearer tok-123456' },
    });
    expect(got.old!.entry).toEqual({ url: 'https://old.example.com/sse', transport: 'sse' });
    expect(got.auth!.skipped).toMatch(/oauth/);
  });
});
