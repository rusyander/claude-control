import { describe, expect, it } from 'vitest';
import type { SessionSpec } from './adapter.types.ts';
import { acpMcpServers, acpRemoteRefusal, carriedMcp, splitCarried } from './mcp-carry.ts';

const spec = (over: Partial<SessionSpec> = {}): SessionSpec =>
  ({
    mcpServers: {
      agentdeck: { command: 'node', args: ['core.mjs'], env: { AGENTDECK_TOKEN: 't' } },
      'agentdeck-permit': { command: 'node', args: ['permit.mjs'] },
      panel: { command: 'node', args: ['bridge.mjs'] },
    },
    permitServer: { name: 'agentdeck-permit', tool: 'permit' },
    ...over,
  }) as unknown as SessionSpec;

describe('mcp carriage into a foreign CLI (s10 p6)', () => {
  it('carries the step servers minus the permit server; the permit question goes by protocol', () => {
    expect(carriedMcp(spec()).map(([name]) => name)).toEqual(['agentdeck', 'panel']);
  });

  it('no permit server in the step — every server is carried', () => {
    const s = spec();
    delete (s as { permitServer?: unknown }).permitServer;
    expect(carriedMcp(s).map(([name]) => name)).toEqual(['agentdeck', 'agentdeck-permit', 'panel']);
  });

  it('ACP form: env becomes a {name, value} list, args are copied, a server without env gets []', () => {
    expect(acpMcpServers(spec(), BOTH)).toEqual([
      {
        name: 'agentdeck',
        command: 'node',
        args: ['core.mjs'],
        env: [{ name: 'AGENTDECK_TOKEN', value: 't' }],
      },
      { name: 'panel', command: 'node', args: ['bridge.mjs'], env: [] },
    ]);
    expect(acpMcpServers(spec({ mcpServers: {} }), BOTH)).toEqual([]);
  });
});

const BOTH = { http: true, sse: true };
const remoteSpec = (): SessionSpec =>
  spec({
    mcpServers: {
      agentdeck: { command: 'node', args: ['core.mjs'] },
      web: {
        url: 'https://mcp.example.com/mcp',
        transport: 'http',
        headers: { Authorization: 'Bearer s' },
      },
      legacy: { url: 'https://old.example.com/sse', transport: 'sse' },
    },
  });

describe('remote MCP carriage (s10 p8)', () => {
  it('ACP form: remote servers get type, url and {name, value} headers when the CLI declares the transport', () => {
    expect(acpMcpServers(remoteSpec(), BOTH)).toEqual([
      { name: 'agentdeck', command: 'node', args: ['core.mjs'], env: [] },
      {
        type: 'http',
        name: 'web',
        url: 'https://mcp.example.com/mcp',
        headers: [{ name: 'Authorization', value: 'Bearer s' }],
      },
      { type: 'sse', name: 'legacy', url: 'https://old.example.com/sse', headers: [] },
    ]);
  });

  it('an undeclared transport is dropped from the list and named as a loss with its server', () => {
    const httpOnly = { http: true, sse: false };
    expect(acpMcpServers(remoteSpec(), httpOnly).map((s) => s.name)).toEqual(['agentdeck', 'web']);
    expect(splitCarried(remoteSpec(), httpOnly, 'x declares http only').lost).toEqual([
      'remote mcp servers not carried (sse: x declares http only): legacy',
    ]);
  });

  it('initialize check: a remote server whose transport the agent did not declare refuses the handshake', () => {
    const servers = acpMcpServers(remoteSpec(), BOTH);
    expect(acpRemoteRefusal(servers, { mcpCapabilities: { http: true, sse: true } })).toBeNull();
    expect(acpRemoteRefusal(servers, { mcpCapabilities: { http: true, sse: false } })).toBe(
      'agent does not declare mcpCapabilities for legacy (sse)',
    );
    expect(acpRemoteRefusal(servers, {})).toMatch(/web \(http\), legacy \(sse\)/);
    expect(acpRemoteRefusal(acpMcpServers(spec(), BOTH), {})).toBeNull();
  });
});
