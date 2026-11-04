import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import type { McpSourceRead } from '../mcp-source/mcp-source.ts';
import { claudeMcpSource } from './mcp-source.ts';

/**
 * Читатель MCP человека у Claude Code (s10 p8, паритет старого чата панели): `.claude.json` (личные
 * и локальные серверы проекта), `.mcp.json` проекта с одобрением, выключенные `/mcp`, `${VAR}`.
 * Ключи — строки сборки 2.1.310 (`enabledMcpjsonServers`, `disabledMcpServers`, `headersHelper`).
 */

function put(path: string, text: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof text === 'string' ? text : JSON.stringify(text));
}

function world() {
  const root = tempDir('claude-mcp-source-');
  const home = join(root, 'home');
  const repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  return { home, repo, pin: { HOME: home, USERPROFILE: home, API_KEY: 'k-123456' } };
}

const byId = (read: McpSourceRead) => Object.fromEntries(read.servers.map((s) => [s.id, s]));
const stdio = (command: string) => ({ type: 'stdio', command });

describe('claude mcp source (s10 p8)', () => {
  it('user < approved project .mcp.json < local project entry; unapproved and /mcp-disabled absent', () => {
    const w = world();
    put(join(w.home, '.claude.json'), {
      mcpServers: { a: stdio('user-a'), b: stdio('user-b'), off: stdio('user-off') },
      projects: {
        [w.repo.replaceAll('\\', '/')]: {
          hasTrustDialogAccepted: true,
          enabledMcpjsonServers: ['b', 'c'],
          disabledMcpServers: ['off'],
          mcpServers: { c: stdio('local-c') },
        },
      },
    });
    put(join(w.repo, '.mcp.json'), {
      mcpServers: { a: stdio('proj-a'), b: stdio('proj-b'), c: stdio('proj-c') },
    });
    const read = claudeMcpSource({
      pin: w.pin,
      cwd: w.repo,
      trust: { sourceRepo: w.repo, panelMark: false },
    });
    const got = byId(read);
    expect(Object.keys(got).sort()).toEqual(['a', 'b', 'c']);
    // `a` в проекте не одобрен — остаётся личный.
    expect(got.a).toMatchObject({ scope: 'user', entry: { command: 'user-a' } });
    expect(got.b).toMatchObject({ scope: 'project', entry: { command: 'proj-b' } });
    // Локальная запись проекта сильнее `.mcp.json`.
    expect(got.c).toMatchObject({ scope: 'user', entry: { command: 'local-c' } });
    expect(read.projectSkipped).toBeUndefined();
  });

  it('enableAllProjectMcpServers in the project settings opens every server; disabledMcpjsonServers wins', () => {
    const w = world();
    put(join(w.home, '.claude.json'), {});
    put(join(w.repo, '.claude', 'settings.local.json'), {
      enableAllProjectMcpServers: true,
      disabledMcpjsonServers: ['no'],
    });
    put(join(w.repo, '.mcp.json'), { mcpServers: { yes: stdio('y'), no: stdio('n') } });
    const read = claudeMcpSource({
      pin: w.pin,
      cwd: w.repo,
      trust: { sourceRepo: w.repo, panelMark: true },
    });
    expect(read.servers.map((s) => s.id)).toEqual(['yes']);
  });

  it('untrusted source repository: .mcp.json unread and the reason named; user servers stay', () => {
    const w = world();
    put(join(w.home, '.claude.json'), { mcpServers: { u: stdio('u') } });
    put(join(w.repo, '.mcp.json'), { mcpServers: { p: stdio('p') } });
    put(join(w.repo, '.claude', 'settings.json'), { enableAllProjectMcpServers: true });
    const read = claudeMcpSource({
      pin: w.pin,
      cwd: w.repo,
      trust: { sourceRepo: w.repo, panelMark: false },
    });
    expect(read.servers.map((s) => s.id)).toEqual(['u']);
    expect(read.projectSkipped).toMatch(/not trusted/);
  });

  it('${VAR} from the pin; unset var without default named; remote http/sse carried with headers; ws and headersHelper named', () => {
    const w = world();
    put(join(w.home, '.claude.json'), {
      mcpServers: {
        env: {
          command: 'srv',
          args: ['--key=${API_KEY}', '${MISSING:-dflt}'],
          env: { K: '${API_KEY}' },
        },
        unset: { command: 'srv', env: { K: '${NOPE}' } },
        web: {
          type: 'http',
          url: 'https://mcp.example.com/mcp',
          headers: { Authorization: 'Bearer ${API_KEY}' },
        },
        old: { type: 'sse', url: 'https://old.example.com/sse' },
        sock: { type: 'ws', url: 'wss://x.example.com' },
        helper: { type: 'http', url: 'https://h.example.com', headersHelper: 'get-token.sh' },
      },
    });
    const got = byId(claudeMcpSource({ pin: w.pin, cwd: w.repo }));
    expect(got.env?.entry).toEqual({
      command: 'srv',
      args: ['--key=k-123456', 'dflt'],
      env: { K: 'k-123456' },
    });
    expect(got.unset?.skipped).toMatch(/env var NOPE unset/);
    expect(got.web?.entry).toEqual({
      url: 'https://mcp.example.com/mcp',
      transport: 'http',
      headers: { Authorization: 'Bearer k-123456' },
    });
    expect(got.old?.entry).toEqual({ url: 'https://old.example.com/sse', transport: 'sse' });
    expect(got.sock?.skipped).toMatch(/transport ws/);
    expect(got.helper?.skipped).toMatch(/headersHelper/);
  });

  it('CLAUDE_CONFIG_DIR moves .claude.json; a broken file is named, not empty', () => {
    const w = world();
    const dir = join(w.home, 'cfg');
    put(join(dir, '.claude.json'), '{ broken');
    const read = claudeMcpSource({ pin: { ...w.pin, CLAUDE_CONFIG_DIR: dir }, cwd: w.repo });
    expect(read.servers).toEqual([]);
    expect(read.unread[0]?.file).toBe(join(dir, '.claude.json'));
  });
});
