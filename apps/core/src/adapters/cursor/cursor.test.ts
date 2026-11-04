import { describe, expect, it } from 'vitest';
import type { SessionSpec } from '../adapter.types.ts';
import {
  bindCursorEndpoint,
  createCursorAdapter,
  createCursorRpcAdapter,
  CURSOR_FILES,
  cursorHooksFile,
  cursorToolName,
  mapCursorPermission,
  planCursor,
  refuseCursor,
} from './index.ts';

/**
 * Cursor без живого CLI: строка реестра отказана `no_core_hook`, переходник ACP — без единой
 * возможности и без канала адреса; файл хука сеанса закрыт при сбое (`failClosed`).
 */

describe('cursor registry entry and ACP adapter facts', () => {
  it('the registry entry refuses launch with no_core_hook and declares nothing', async () => {
    const adapter = createCursorAdapter();
    // Не заготовка: переходник есть, но защиты ядра нет — причина отказа `no_core_hook`, не «не построен».
    expect(adapter.built).toBeUndefined();
    expect(Object.values(adapter.caps).filter((v) => v === true)).toEqual([]);
    const launched = await adapter.launch({} as SessionSpec);
    expect(launched.ok ? '' : launched.reason).toMatch(/^no_core_hook: cursor /);
  });

  it('the ACP adapter declares no cap and no channel; any endpoint is refused', () => {
    const adapter = createCursorRpcAdapter();
    expect(Object.values(adapter.caps).filter((v) => v === true)).toEqual([]);
    expect(adapter.caps.channels).toEqual([]);
    expect(bindCursorEndpoint()).toEqual({ ok: false, code: 'no_channel' });
  });

  it('refuses without the core hook, with a routed endpoint, and on resume', () => {
    expect(refuseCursor({} as SessionSpec)).toMatch(/^no core hook/);
    expect(refuseCursor({ coreHook: 'h', endpoint: {} } as never)).toMatch(/no endpoint channel/);
    expect(refuseCursor({ coreHook: 'h', resume: 'x' } as never)).toMatch(/resume/);
    expect(refuseCursor({ coreHook: 'h' } as SessionSpec)).toBeNull();
  });

  it('plan: own HOME inside the session dir, no invented config-dir variable, hooks file fail-closed', () => {
    const plan = planCursor(
      { dir: '/s/1', coreHook: 'node hook', mcpServers: {} } as unknown as SessionSpec,
      null,
      {} as never,
    );
    expect(plan.args).toEqual(['acp']);
    expect(plan.env.HOME?.replace(/\\/g, '/')).toBe('/s/1/cursor-home');
    expect(plan.env.USERPROFILE?.replace(/\\/g, '/')).toBe('/s/1/cursor-home');
    expect(Object.keys(plan.env).sort()).toEqual(['HOME', 'USERPROFILE']);
    expect(Object.keys(plan.files)).toEqual([CURSOR_FILES.hooks]);
    expect(JSON.parse(cursorHooksFile('node hook'))).toEqual({
      version: 1,
      hooks: { preToolUse: [{ command: 'node hook', failClosed: true }] },
    });
  });

  it('step MCP servers are a named loss with the unproven door, never a session mcp.json (s10 p11)', () => {
    const plan = planCursor(
      {
        dir: '/s/1',
        coreHook: 'node hook',
        mcpServers: { probe: { command: 'node', args: ['p.mjs'] }, docs: { url: 'http://h/mcp' } },
      } as unknown as SessionSpec,
      null,
      {} as never,
    );
    expect(plan.layerLosses).toEqual([
      'mcp servers not carried (cursor-agent never ran live here: neither ACP session/new mcpServers nor a session .cursor/mcp.json is proven to start a server without a prompt): probe, docs',
    ]);
    expect(Object.keys(plan.files)).toEqual([CURSOR_FILES.hooks]);
  });

  it('call vocabulary: kind names the tool, shell and edits map to the core classes', () => {
    expect(cursorToolName({ kind: 'execute', title: 'git status' })).toBe('Shell');
    expect(cursorToolName({ kind: 'other', title: 'Mystery' })).toBe('Mystery');
    expect(mapCursorPermission({ tool: 'Shell', input: { command: 'git push' } })).toMatchObject({
      action: 'exec',
      argv: ['git', 'push'],
      argvExact: true,
    });
    expect(mapCursorPermission({ tool: 'Edit', input: { path: '/w/a' } })).toMatchObject({
      action: 'edit',
      target: '/w/a',
    });
    expect(mapCursorPermission({ tool: 'Read', input: {} })).toMatchObject({ action: 'other' });
  });
});
