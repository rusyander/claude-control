import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpOffersReply } from '@agentdeck/contracts/core/panel-api';
import { afterEach, describe, expect, it } from 'vitest';
import { createAdapterRegistry } from '../adapters/index.ts';
import { createMcpOffersPort } from '../bootstrap/mcp-offers.ts';
import { startStand, TOKENS, type Stand } from './__fixtures__/api-harness.ts';

/**
 * `GET /v1/mcp-offers` (s10 p9): настоящие читатели конфига MCP переходников (тот же
 * `adapter.mcpSource`, что у дороги) над временным домом. Видно: серверы по CLI с областью и видом
 * запуска, значения `env`/заголовков в ответ не уходят, виды шага с отметкой «берёт серверы
 * человека», суд чтения как у `/v1/config` (токену сессии — 401), без порта — 501.
 */

const SECRET = 'offer-secret-value-7731';
let stand: Stand | undefined;
let root = '';

afterEach(async () => {
  await stand?.close();
  stand = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});

function humanHome(): Record<string, string> {
  root = mkdtempSync(join(tmpdir(), 'mcp-offers-'));
  const home = join(root, 'home');
  const cfg = join(home, 'cfg');
  mkdirSync(cfg, { recursive: true });
  writeFileSync(
    join(cfg, '.claude.json'),
    JSON.stringify({
      mcpServers: {
        probe: { command: 'node', args: ['probe.mjs'], env: { TOKEN: SECRET } },
        broken: { args: ['no-command'] },
      },
    }),
  );
  const codexHome = join(home, '.codex');
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(
    join(codexHome, 'config.toml'),
    [
      '[mcp_servers.remote-docs]',
      'url = "https://mcp.example.com/mcp"',
      `http_headers = { "X-Key" = "${SECRET}" }`,
      '',
    ].join('\n'),
  );
  return {
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: cfg,
    CODEX_HOME: codexHome,
  };
}

async function offers(s: Stand, token = TOKENS.panel) {
  const res = await s.get('/v1/mcp-offers', token);
  return { status: res.status, text: await res.text() };
}

describe('GET /v1/mcp-offers — human MCP offers per CLI (s10 p9)', () => {
  it('names each CLI server with scope and transport, never its env or header values', async () => {
    const port = createMcpOffersPort(createAdapterRegistry(), humanHome());
    stand = await startStand(undefined, { mcpOffers: () => port });
    const got = await offers(stand);
    expect(got.status).toBe(200);
    expect(got.text).not.toContain(SECRET);
    const body = JSON.parse(got.text) as McpOffersReply;
    const claude = body.clis.find((c) => c.cli === 'claude');
    expect(claude?.servers.find((s) => s.id === 'probe')).toMatchObject({
      scope: 'user',
      transport: 'stdio',
    });
    const broken = claude?.servers.find((s) => s.id === 'broken');
    expect(broken?.transport).toBeNull();
    expect(broken?.skipped).toBeTruthy();
    const codex = body.clis.find((c) => c.cli === 'codex');
    expect(codex?.servers.find((s) => s.id === 'remote-docs')?.transport).toBe('remote');
    // CLI без читателя назван, а не молча пропущен.
    expect(body.noReader).toContain('gemini');
    expect(body.clis.map((c) => c.cli)).not.toContain('gemini');
  });

  it('marks which step kinds take human servers: read-only kinds do not, chat takes all by default', async () => {
    const port = createMcpOffersPort(createAdapterRegistry(), humanHome());
    stand = await startStand(undefined, { mcpOffers: () => port });
    const body = JSON.parse((await offers(stand)).text) as McpOffersReply;
    const kind = (k: string) => body.kinds.find((x) => x.kind === k);
    expect(kind('work')).toEqual({ kind: 'work', takesHuman: true, allByDefault: false });
    expect(kind('review')?.takesHuman).toBe(false);
    expect(kind('research')?.takesHuman).toBe(false);
    expect(kind('chat')).toEqual({ kind: 'chat', takesHuman: true, allByDefault: true });
  });

  it('reads like /v1/config: the session token is refused 401, no port answers 501', async () => {
    const port = createMcpOffersPort(createAdapterRegistry(), humanHome());
    stand = await startStand(undefined, { mcpOffers: () => port });
    expect((await offers(stand, TOKENS.session)).status).toBe(401);
    expect((await offers(stand, TOKENS.core)).status).toBe(200);
    await stand.close();
    stand = await startStand();
    expect((await offers(stand)).status).toBe(501);
  });
});
